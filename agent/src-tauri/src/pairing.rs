// Pairing flow — runs once at first boot (no device_id yet) and also if
// pairing gets cleared (e.g. after a full reset).
//
//   1. POST /createPairingCode          → 6-digit code + 10-min TTL
//   2. Poll /checkPairingCode every 5s  → {claimed:false} while waiting
//   3. On { claimed:true, deviceId, token }:
//        signInWithCustomToken  (identity toolkit REST)
//          → id_token + refresh_token + expiresIn
//        persist device_id / refresh_token / id_token / id_token_expires_at
// During the loop we keep a fresh `pairing_code` in the kv so the overlay can
// read it and show the current code to the child/parent.
//
// If the 10-min TTL expires before a claim we allocate a new code and keep
// going. No exit path other than success — the agent can't be useful without
// a device identity.

use anyhow::{Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

use crate::storage::AppState;

// Override at build time if ever needed (e.g. emulator).
const FUNCTIONS_BASE: &str = match option_env!("TICKTOCK_FUNCTIONS_BASE") {
    Some(v) => v,
    None => "https://asia-northeast3-ticktock-bc713.cloudfunctions.net",
};
const FIREBASE_API_KEY: &str = match option_env!("TICKTOCK_FIREBASE_API_KEY") {
    Some(v) => v,
    None => "AIzaSyB-VLXcCpPoyRKyU7h2U-ZvnJb9q8fZWho",
};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const CODE_TTL_SECS: i64 = 600;

pub async fn run_loop(app: AppHandle, state: AppState) {
    loop {
        if already_paired(&state).await {
            return;
        }
        match one_cycle(&app, &state).await {
            Ok(true) => return, // paired — unlock already handled in the cycle
            Ok(false) => {}      // code expired, loop and issue a fresh one
            Err(e) => {
                log::warn!("pairing cycle error: {e:#}");
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        }
    }
}

async fn already_paired(state: &AppState) -> bool {
    match (
        state.kv_get("device_id").await.ok().flatten(),
        state.kv_get("refresh_token").await.ok().flatten(),
    ) {
        (Some(_), Some(_)) => true,
        _ => false,
    }
}

// Returns Ok(true) when pairing succeeded (caller should exit), Ok(false) on
// TTL expiry (caller should allocate a new code).
async fn one_cycle(app: &AppHandle, state: &AppState) -> Result<bool> {
    let code = create_code().await?;
    state.kv_set("pairing_code", &code).await?;
    log::info!("pairing code issued: {code}");

    let deadline = Utc::now() + ChronoDuration::seconds(CODE_TTL_SECS - 10);
    while Utc::now() < deadline {
        tokio::time::sleep(POLL_INTERVAL).await;
        match check_code(&code).await {
            Ok(Some(pair)) => {
                log::info!("pairing claimed: device_id={}", pair.device_id);
                let tokens = sign_in_with_custom_token(&pair.token).await?;
                persist_identity(state, &pair.device_id, &tokens).await?;
                state.kv_set("pairing_code", "").await.ok();
                // If the child has already set a PIN, unlock the overlay — first-run
                // flow is now complete. If not, leave the overlay showing so the UI
                // can go back to the PIN-setup screen (shouldn't happen in practice:
                // the Overlay UI forces PIN-setup before pairing).
                if state.kv_get("pin_hash").await?.is_some() {
                    crate::lock::overlay::hide(app).await.ok();
                    state
                        .set_locked(false, crate::schedule::LockReason::Manual)
                        .await;
                }
                return Ok(true);
            }
            Ok(None) => continue,
            Err(e) => {
                log::debug!("pairing check: {e}");
                continue;
            }
        }
    }
    log::info!("pairing code {code} expired — allocating new code");
    Ok(false)
}

struct ClaimedPair {
    device_id: String,
    token: String,
}

pub struct IdentityTokens {
    pub id_token: String,
    pub refresh_token: String,
    pub expires_at: DateTime<Utc>,
}

async fn create_code() -> Result<String> {
    let url = format!("{FUNCTIONS_BASE}/createPairingCode");
    let resp: Value = reqwest::Client::new()
        .post(&url)
        .json(&json!({}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    resp.get("code")
        .and_then(Value::as_str)
        .map(String::from)
        .context("createPairingCode: missing 'code'")
}

async fn check_code(code: &str) -> Result<Option<ClaimedPair>> {
    let url = format!("{FUNCTIONS_BASE}/checkPairingCode");
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&json!({ "code": code }))
        .send()
        .await?;
    // 404 = the server already consumed the node — treat as "still pending"
    // rather than an error so the overlay keeps showing the code.
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if resp.status() == reqwest::StatusCode::GONE {
        anyhow::bail!("code expired");
    }
    let v: Value = resp.error_for_status()?.json().await?;
    if v.get("claimed").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    let device_id = v
        .get("deviceId")
        .and_then(Value::as_str)
        .context("missing deviceId")?
        .to_string();
    let token = v
        .get("token")
        .and_then(Value::as_str)
        .context("missing token")?
        .to_string();
    Ok(Some(ClaimedPair { device_id, token }))
}

pub async fn sign_in_with_custom_token(custom_token: &str) -> Result<IdentityTokens> {
    let url = format!(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={FIREBASE_API_KEY}"
    );
    let v: Value = reqwest::Client::new()
        .post(&url)
        .json(&json!({ "token": custom_token, "returnSecureToken": true }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    parse_identity(v)
}

pub async fn refresh_id_token(refresh_token: &str) -> Result<IdentityTokens> {
    let url =
        format!("https://securetoken.googleapis.com/v1/token?key={FIREBASE_API_KEY}");
    let v: Value = reqwest::Client::new()
        .post(&url)
        .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    // Secure-token endpoint uses snake_case keys (id_token, refresh_token, expires_in).
    parse_identity_refresh(v)
}

fn parse_identity(v: Value) -> Result<IdentityTokens> {
    let id_token = v
        .get("idToken")
        .and_then(Value::as_str)
        .context("no idToken")?
        .to_string();
    let refresh_token = v
        .get("refreshToken")
        .and_then(Value::as_str)
        .context("no refreshToken")?
        .to_string();
    let expires_in: i64 = v
        .get("expiresIn")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .unwrap_or(3600);
    // Refresh 60s before expiry to avoid expired-token races.
    Ok(IdentityTokens {
        id_token,
        refresh_token,
        expires_at: Utc::now() + ChronoDuration::seconds(expires_in - 60),
    })
}

fn parse_identity_refresh(v: Value) -> Result<IdentityTokens> {
    let id_token = v
        .get("id_token")
        .and_then(Value::as_str)
        .context("no id_token")?
        .to_string();
    let refresh_token = v
        .get("refresh_token")
        .and_then(Value::as_str)
        .context("no refresh_token")?
        .to_string();
    let expires_in: i64 = v
        .get("expires_in")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .unwrap_or(3600);
    Ok(IdentityTokens {
        id_token,
        refresh_token,
        expires_at: Utc::now() + ChronoDuration::seconds(expires_in - 60),
    })
}

async fn persist_identity(
    state: &AppState,
    device_id: &str,
    t: &IdentityTokens,
) -> Result<()> {
    state.kv_set("device_id", device_id).await?;
    state.kv_set("id_token", &t.id_token).await?;
    state.kv_set("refresh_token", &t.refresh_token).await?;
    state
        .kv_set("id_token_expires_at", &t.expires_at.to_rfc3339())
        .await?;
    Ok(())
}

pub async fn save_refreshed(state: &AppState, t: &IdentityTokens) -> Result<()> {
    state.kv_set("id_token", &t.id_token).await?;
    state.kv_set("refresh_token", &t.refresh_token).await?;
    state
        .kv_set("id_token_expires_at", &t.expires_at.to_rfc3339())
        .await?;
    Ok(())
}
