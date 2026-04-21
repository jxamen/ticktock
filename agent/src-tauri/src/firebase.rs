// Firebase RTDB client — REST writes + SSE streaming subscription.
//
// Architecture:
//   - RTDB_URL is compiled in via env!("TICKTOCK_RTDB_URL") with a dev fallback.
//   - Device identity (device_id + auth_token) is loaded from AppState kv.
//     Pairing flow writes these; if absent, the agent waits for pairing.
//   - run_listener opens an SSE stream at /devices/{id}.json and processes
//     `put` / `patch` events. Each event carries a path relative to the stream
//     root and a data value.
//   - run_heartbeat writes /state every 30s and PATCHes /usage/{today} with
//     dirty seconds accumulated since the last flush.

use anyhow::{bail, Context, Result};
use eventsource_client::{Client, ClientBuilder, SSE};
use futures::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

use crate::{commands, pairing, storage::AppState};

const RTDB_URL: &str = match option_env!("TICKTOCK_RTDB_URL") {
    Some(v) => v,
    None => "https://ticktock-bc713-default-rtdb.asia-southeast1.firebasedatabase.app",
};

// --- Listener ---

pub async fn run_listener(app: AppHandle, state: AppState) {
    loop {
        match listen_once(&app, &state).await {
            Ok(()) => log::info!("listener closed cleanly, reconnecting in 5s"),
            Err(e) => log::warn!("listener error: {e:#}, reconnecting in 5s"),
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn listen_once(app: &AppHandle, state: &AppState) -> Result<()> {
    let (device_id, token) = match identity(state).await? {
        Some(v) => v,
        None => {
            log::info!("no device identity yet — waiting for pairing");
            tokio::time::sleep(Duration::from_secs(30)).await;
            return Ok(());
        }
    };

    let url = format!("{}/devices/{}.json?auth={}", RTDB_URL, device_id, token);
    let client = ClientBuilder::for_url(&url)?
        .reconnect(
            eventsource_client::ReconnectOptionsBuilder::new(true)
                .retry_initial(true)
                .delay(Duration::from_secs(2))
                .build(),
        )
        .build();

    let mut stream = client.stream();
    while let Some(event) = stream.next().await {
        match event {
            Ok(SSE::Event(ev)) => {
                if let Err(e) = handle_sse_event(app, state, &ev.event_type, &ev.data).await {
                    log::warn!("event handler error: {e:#}");
                }
            }
            Ok(SSE::Comment(_)) | Ok(SSE::Connected(_)) => {}
            Err(e) => {
                log::warn!("sse error: {e}");
                bail!("sse disconnected");
            }
        }
    }
    Ok(())
}

async fn handle_sse_event(
    app: &AppHandle,
    state: &AppState,
    event_type: &str,
    data: &str,
) -> Result<()> {
    // RTDB SSE events are `put` (replace at path) and `patch` (merge at path).
    // Payload: { "path": "/commands/xyz", "data": { ... } }
    if event_type != "put" && event_type != "patch" {
        return Ok(());
    }
    let parsed: Value = serde_json::from_str(data)?;
    let path = parsed.get("path").and_then(Value::as_str).unwrap_or("/");
    let payload = parsed.get("data").cloned().unwrap_or(Value::Null);

    if path.starts_with("/commands/") {
        if let Some(cid) = path.strip_prefix("/commands/") {
            dispatch_command(app, state, cid, &payload).await?;
        }
    } else if path == "/schedule" || path.starts_with("/schedule/") {
        // Pull the whole schedule freshly rather than merging in place.
        if let Some(sched) = payload.as_object() {
            let schedule: crate::schedule::Schedule = serde_json::from_value(Value::Object(sched.clone()))?;
            state.set_schedule(schedule).await?;
        }
    } else if path == "/" {
        // Initial snapshot of the whole device node.
        if let Some(schedule) = parsed.pointer("/data/schedule") {
            if let Ok(s) = serde_json::from_value::<crate::schedule::Schedule>(schedule.clone()) {
                state.set_schedule(s).await?;
            }
        }
        if let Some(commands_obj) = parsed.pointer("/data/commands").and_then(Value::as_object) {
            for (cid, cmd) in commands_obj {
                dispatch_command(app, state, cid, cmd).await?;
            }
        }
    }
    Ok(())
}

async fn dispatch_command(app: &AppHandle, state: &AppState, cid: &str, cmd: &Value) -> Result<()> {
    if cmd.get("consumed").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let cmd_type = cmd.get("type").and_then(Value::as_str).unwrap_or("");
    let payload = cmd.get("payload").cloned().unwrap_or(Value::Null);
    commands::handle_remote_command(app, state, cmd_type, payload).await?;
    mark_consumed(state, cid).await?;
    Ok(())
}

async fn mark_consumed(state: &AppState, cid: &str) -> Result<()> {
    let (device_id, token) = identity(state).await?.context("no identity")?;
    let url = format!(
        "{}/devices/{}/commands/{}.json?auth={}",
        RTDB_URL, device_id, cid, token
    );
    reqwest::Client::new()
        .patch(&url)
        .json(&json!({ "consumed": true, "consumedAt": chrono::Utc::now().timestamp_millis() }))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

// --- State change pusher ---

// Runs alongside the 30s heartbeat. Listens for lock-state changes and pushes
// immediately so the parent app reflects lock/unlock/OTP-consume transitions
// within a second rather than after a heartbeat tick. A short debounce
// coalesces rapid consecutive changes into one write.
pub async fn run_state_pusher(_app: AppHandle, state: AppState) {
    loop {
        state.wait_state_changed().await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Err(e) = push_state(&state).await {
            log::debug!("immediate state push failed: {e:#}");
        }
    }
}

// --- Heartbeat + usage push ---

pub async fn run_heartbeat(_app: AppHandle, state: AppState) {
    let mut state_interval = tokio::time::interval(Duration::from_secs(30));
    let mut usage_interval = tokio::time::interval(Duration::from_secs(300));
    loop {
        tokio::select! {
            _ = state_interval.tick() => {
                if let Err(e) = push_state(&state).await {
                    log::debug!("state push failed: {e:#}");
                }
            }
            _ = usage_interval.tick() => {
                if let Err(e) = push_usage(&state).await {
                    log::debug!("usage push failed: {e:#}");
                }
            }
        }
    }
}

async fn push_state(state: &AppState) -> Result<()> {
    let Some((device_id, token)) = identity(state).await? else { return Ok(()) };
    let session_expires_ms = state
        .session_expires_at()
        .await
        .map(|t| t.timestamp_millis());
    let session_paused = state.session_paused_seconds().await;
    let payload = json!({
        "locked": state.is_locked().await,
        "lockReason": format!("{:?}", state.lock_reason().await).to_lowercase(),
        "lastHeartbeat": chrono::Utc::now().timestamp_millis(),
        "todayUsedMinutes": state.today_used_minutes().await,
        "agentVersion": env!("CARGO_PKG_VERSION"),
        "sessionExpiresAt": session_expires_ms,
        "sessionPausedSeconds": session_paused,
    });
    let url = format!("{}/devices/{}/state.json?auth={}", RTDB_URL, device_id, token);
    reqwest::Client::new()
        .put(&url)
        .json(&payload)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn push_usage(state: &AppState) -> Result<()> {
    let Some((device_id, token)) = identity(state).await? else { return Ok(()) };
    let (date, dirty) = state.drain_dirty_usage().await;
    if dirty.is_empty() {
        return Ok(());
    }
    // RTDB PATCH merges provided keys; values are absolute seconds for today so
    // we need to know today's total, not just the delta. Read current, add delta, write.
    let date_str = date.format("%Y-%m-%d").to_string();
    let url = format!(
        "{}/devices/{}/usage/{}.json?auth={}",
        RTDB_URL, device_id, date_str, token
    );
    // Instead of read-modify-write (race-prone), we rely on server-side increment
    // via a shallow PATCH of per-process totals computed locally from daily_summary.
    // Simpler: just PATCH with local totals-of-today — the daily_summary table is
    // authoritative on-device.
    let totals = local_today_totals(state, &date_str).await?;
    let mut patch = serde_json::Map::new();
    for (name, secs) in totals.into_iter().filter(|(k, _)| dirty.contains_key(k)) {
        patch.insert(name, json!(secs));
    }
    if patch.is_empty() {
        return Ok(());
    }
    reqwest::Client::new()
        .patch(&url)
        .json(&Value::Object(patch))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn local_today_totals(state: &AppState, date_ymd: &str) -> Result<Vec<(String, i64)>> {
    // Expose a method via AppState rather than reaching into its internals.
    state.daily_summary(date_ymd).await
}

/// Overwrite /devices/{id}/usage/{date} with null so the parent app's totals
/// drop to zero after a reset command.
pub async fn clear_usage_day(state: &AppState, date_ymd: &str) -> Result<()> {
    let Some((device_id, token)) = identity(state).await? else { return Ok(()); };
    let url = format!(
        "{}/devices/{}/usage/{}.json?auth={}",
        RTDB_URL, device_id, date_ymd, token
    );
    reqwest::Client::new()
        .put(&url)
        .json(&Value::Null)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

// --- Identity ---

// Returns (device_id, id_token). Refreshes the id_token via the securetoken
// endpoint when it's within 60s of expiry — the refresh window baked into
// pairing.rs::parse_identity already subtracts 60s, so a positive kv value
// means the token is still good.
async fn identity(state: &AppState) -> Result<Option<(String, String)>> {
    let Some(device_id) = state.kv_get("device_id").await? else { return Ok(None) };
    let Some(refresh_token) = state.kv_get("refresh_token").await? else { return Ok(None) };

    if let (Some(id_token), Some(expires_str)) = (
        state.kv_get("id_token").await?,
        state.kv_get("id_token_expires_at").await?,
    ) {
        if let Ok(expires_at) = chrono::DateTime::parse_from_rfc3339(&expires_str) {
            if chrono::Utc::now() < expires_at.with_timezone(&chrono::Utc) {
                return Ok(Some((device_id, id_token)));
            }
        }
    }

    // Expired or never issued — refresh.
    let tokens = pairing::refresh_id_token(&refresh_token).await?;
    let id_token = tokens.id_token.clone();
    pairing::save_refreshed(state, &tokens).await?;
    Ok(Some((device_id, id_token)))
}
