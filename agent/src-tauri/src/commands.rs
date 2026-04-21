// Tauri command handlers (IPC from the React UI to Rust) and Firebase command
// dispatcher (remote commands from the parent app).

use anyhow::Result;
use chrono::{Duration as ChronoDuration, Utc};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::{
    lock,
    lock::pin,
    schedule::{LockReason, Schedule},
    storage::AppState,
};

// ----- IPC: called from the UI via invoke() -----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStateDto {
    pub locked: bool,
    pub lock_reason: String,
    pub today_used_minutes: u32,
}

#[tauri::command]
pub async fn get_current_state(state: State<'_, AppState>) -> Result<DeviceStateDto, String> {
    Ok(DeviceStateDto {
        locked: state.is_locked().await,
        lock_reason: format!("{:?}", state.lock_reason().await).to_lowercase(),
        today_used_minutes: state.today_used_minutes().await,
    })
}

#[tauri::command]
pub async fn verify_pin_and_unlock(
    app: AppHandle,
    state: State<'_, AppState>,
    pin: String,
) -> Result<bool, String> {
    if state.pin_locked_out().await.map_err(s)? {
        return Err("너무 많은 시도. 10분 후 다시 시도하세요.".into());
    }

    // Main PIN: unlocks indefinitely. Ends any ongoing session and discards
    // the one-time-PIN slot (parent explicitly took control).
    if let Some(hash) = state.kv_get("pin_hash").await.map_err(s)? {
        if pin::verify(&pin, &hash) {
            state.record_pin_attempt(true).await.map_err(s)?;
            state.clear_session().await;
            state.clear_temp_pin().await.map_err(s)?;
            lock::timer::hide(&app).await.map_err(s)?;
            lock::overlay::hide(&app).await.map_err(s)?;
            state.set_locked(false, LockReason::Manual).await;
            return Ok(true);
        }
    }

    // One-time PIN: starts a session on first use, resumes a paused session
    // on later uses. The PIN stays in kv so the child can re-enter it after a
    // parent lock; it's cleared only when the session finally expires or the
    // main PIN is used.
    if let Some((temp_hash, minutes)) = state.get_temp_pin().await.map_err(s)? {
        if minutes > 0 && pin::verify(&pin, &temp_hash) {
            state.record_pin_attempt(true).await.map_err(s)?;
            if state.session_paused_seconds().await.is_some() {
                state.resume_session().await;
            } else if state.session_expires_at().await.is_none() {
                let expires_at = Utc::now() + ChronoDuration::minutes(minutes as i64);
                state.set_session_expires_at(Some(expires_at)).await;
            }
            lock::overlay::hide(&app).await.map_err(s)?;
            state.set_locked(false, LockReason::Manual).await;
            lock::timer::show(&app).await.map_err(s)?;
            return Ok(true);
        }
    }

    state.record_pin_attempt(false).await.map_err(s)?;
    Ok(false)
}

#[tauri::command]
pub async fn set_pin(state: State<'_, AppState>, pin: String) -> Result<(), String> {
    let hash = pin::hash(&pin).map_err(s)?;
    state.kv_set("pin_hash", &hash).await.map_err(s)?;
    Ok(())
}

#[tauri::command]
pub async fn has_pin(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.kv_get("pin_hash").await.map_err(s)?.is_some())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatusDto {
    pub paired: bool,
    pub code: Option<String>,
}

// Polled by the overlay during first-run pairing. `code` is cleared once
// pairing.rs persists the device identity.
#[tauri::command]
pub async fn get_pairing_status(state: State<'_, AppState>) -> Result<PairingStatusDto, String> {
    let paired = state.kv_get("device_id").await.map_err(s)?.is_some();
    let code = state
        .kv_get("pairing_code")
        .await
        .map_err(s)?
        .filter(|c| !c.is_empty());
    Ok(PairingStatusDto { paired, code })
}

// First-run PIN setup. Saves the hash and, if pairing is already done, unlocks
// the overlay. If pairing hasn't happened yet (common first-run case), the
// overlay stays up — the UI switches to the pairing-code screen and
// pairing::run_loop handles the unlock when the parent app claims the code.
#[tauri::command]
pub async fn setup_pin_and_unlock(
    app: AppHandle,
    state: State<'_, AppState>,
    pin: String,
) -> Result<(), String> {
    if state.kv_get("pin_hash").await.map_err(s)?.is_some() {
        return Err("PIN이 이미 설정되어 있습니다.".into());
    }
    let hash = pin::hash(&pin).map_err(s)?;
    state.kv_set("pin_hash", &hash).await.map_err(s)?;
    if state.kv_get("device_id").await.map_err(s)?.is_some() {
        lock::overlay::hide(&app).await.map_err(s)?;
        state.set_locked(false, LockReason::Manual).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn register_device(_state: State<'_, AppState>, code: String) -> Result<String, String> {
    // TODO: POST pairing code to Cloud Function, store returned device_id + auth_token.
    let _ = code;
    Err("not implemented — see docs/firebase-setup.md pairing flow".into())
}

#[tauri::command]
pub async fn lock_now(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Pause the session (not discard) so a later unlock can resume remaining time.
    state.pause_session().await;
    lock::timer::hide(&app).await.map_err(s)?;
    lock::overlay::show(&app).await.map_err(s)?;
    state.set_locked(true, LockReason::Manual).await;
    Ok(())
}

// Issue a one-time PIN valid for `minutes` starting when the child enters it.
// If `pin` is None, generate a random 4-digit PIN. Returns the plaintext PIN
// so the caller can show it to the child. Overwrites any existing one-time PIN.
#[tauri::command]
pub async fn issue_one_time_pin(
    state: State<'_, AppState>,
    pin: Option<String>,
    minutes: u32,
) -> Result<String, String> {
    if minutes == 0 {
        return Err("분(minutes)은 1 이상이어야 합니다.".into());
    }
    let pin_str = match pin {
        Some(p) => p,
        None => generate_pin(4),
    };
    let hash = pin::hash(&pin_str).map_err(s)?;
    // New PIN replaces any in-progress session — parent's intent is a fresh grant.
    state.clear_session().await;
    state.set_temp_pin(&hash, minutes).await.map_err(s)?;
    Ok(pin_str)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TimerInfo {
    pub kind: String,       // "session" | "daily" | "schedule"
    pub remaining_seconds: i64,
    pub today_used_minutes: u32,
    pub daily_limit_minutes: u32,
}

// Describes why the overlay is currently up, so the child can see what they
// have to wait for (paused session remaining / next allowed window / etc.).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LockStatusDto {
    pub locked: bool,
    pub reason: String,
    pub paused_seconds: Option<i64>,
    pub next_allowed_at_ms: Option<i64>,
    pub daily_limit_minutes: u32,
    pub today_used_minutes: u32,
}

#[tauri::command]
pub async fn get_lock_status(state: State<'_, AppState>) -> Result<LockStatusDto, String> {
    let schedule = state.current_schedule().await;
    let tz = state.timezone().await;
    let now = chrono::Utc::now().with_timezone(&tz);
    let next = crate::schedule::next_allowed_start(&schedule, now)
        .map(|dt| dt.with_timezone(&chrono::Utc).timestamp_millis());
    Ok(LockStatusDto {
        locked: state.is_locked().await,
        reason: format!("{:?}", state.lock_reason().await).to_lowercase(),
        paused_seconds: state.session_paused_seconds().await,
        next_allowed_at_ms: next,
        daily_limit_minutes: schedule.daily_limit_minutes,
        today_used_minutes: state.today_used_minutes().await,
    })
}

#[tauri::command]
pub async fn get_timer_info(state: State<'_, AppState>) -> Result<Option<TimerInfo>, String> {
    let schedule = state.current_schedule().await;
    let used = state.today_used_minutes().await;
    let limit = schedule.daily_limit_minutes;

    // Priority: one-time-PIN session > daily limit > schedule-window end.
    if let Some(remaining) = state.session_remaining_seconds().await {
        return Ok(Some(TimerInfo {
            kind: "session".into(),
            remaining_seconds: remaining,
            today_used_minutes: used,
            daily_limit_minutes: limit,
        }));
    }

    if limit > 0 && used < limit {
        let remaining_minutes = limit - used;
        return Ok(Some(TimerInfo {
            kind: "daily".into(),
            remaining_seconds: (remaining_minutes as i64) * 60,
            today_used_minutes: used,
            daily_limit_minutes: limit,
        }));
    }

    let tz = state.timezone().await;
    let now = chrono::Utc::now().with_timezone(&tz);
    if let Some(secs) = crate::schedule::current_window_remaining_seconds(&schedule, now) {
        return Ok(Some(TimerInfo {
            kind: "schedule".into(),
            remaining_seconds: secs,
            today_used_minutes: used,
            daily_limit_minutes: limit,
        }));
    }

    Ok(None)
}

fn generate_pin(digits: usize) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..digits).map(|_| rng.gen_range(0..10).to_string()).collect()
}

// ----- Remote commands from Firebase -----

pub async fn handle_remote_command(
    app: &AppHandle,
    state: &AppState,
    command_type: &str,
    payload: Value,
) -> Result<()> {
    match command_type {
        "lock" => {
            // Preserve any active one-time-PIN session as paused seconds so
            // a later unlock can resume from where it left off.
            state.pause_session().await;
            lock::overlay::show(app).await?;
            state.set_locked(true, LockReason::Manual).await;
        }
        "unlock" => {
            // Resume a paused session if one exists — restores the timer.
            state.resume_session().await;
            lock::overlay::hide(app).await?;
            state.set_locked(false, LockReason::Manual).await;
        }
        "setSchedule" => {
            let schedule: Schedule = serde_json::from_value(payload)?;
            state.set_schedule(schedule).await?;
        }
        "setAppLimit" => {
            let process_name = payload
                .get("processName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let minutes = payload.get("minutes");
            let mut schedule = state.current_schedule().await;
            if let Some(v) = minutes.and_then(Value::as_u64) {
                schedule.per_app_limits.insert(process_name, v as u32);
            } else {
                schedule.per_app_limits.remove(&process_name);
            }
            state.set_schedule(schedule).await?;
        }
        "grantBonus" => {
            let minutes = payload.get("minutes").and_then(Value::as_u64).unwrap_or(0) as u32;
            state.grant_bonus_minutes(minutes).await?;
        }
        "revokeOneTimePin" => {
            // Cancel: drop the PIN and any running/paused session for it.
            state.clear_session().await;
            state.clear_temp_pin().await?;
            // If currently unlocked by the session, relock.
            if !state.is_locked().await {
                lock::timer::hide(app).await?;
                lock::overlay::show(app).await?;
                state.set_locked(true, LockReason::Manual).await;
            }
        }
        "adjustOneTimePin" => {
            let minutes = payload.get("minutes").and_then(Value::as_u64).unwrap_or(0) as u32;
            if minutes == 0 {
                anyhow::bail!("adjustOneTimePin: minutes must be >= 1");
            }
            state.adjust_session_minutes(minutes).await?;
        }
        "resetTodayUsage" => {
            let today = state.reset_today_usage().await?;
            let date_str = today.format("%Y-%m-%d").to_string();
            // Clear the RTDB snapshot so the parent app sees 0 immediately.
            crate::firebase::clear_usage_day(state, &date_str).await.ok();
        }
        "issueOneTimePin" => {
            // Parent app pre-generates the plaintext PIN (it needs to show it to
            // the child anyway), so we only hash + store.
            let pin_str = payload
                .get("pin")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("issueOneTimePin: missing 'pin'"))?;
            let minutes = payload.get("minutes").and_then(Value::as_u64).unwrap_or(0) as u32;
            if minutes == 0 {
                anyhow::bail!("issueOneTimePin: minutes must be >= 1");
            }
            let hash = pin::hash(pin_str)?;
            // Fresh grant: drop any leftover session time from the previous PIN.
            state.clear_session().await;
            state.set_temp_pin(&hash, minutes).await?;
        }
        other => log::warn!("unknown command type: {other}"),
    }
    Ok(())
}

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
