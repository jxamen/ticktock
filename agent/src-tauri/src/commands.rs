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
    // Record the Windows user who set up the PIN into the shared config so
    // the service's spawner filters out other sessions from now on — but
    // only when the PIN was set from a standard-user (child) session. If
    // the parent (an administrator) sets the PIN from their own account,
    // we must NOT add them to allowed_users: the parent's account is
    // supposed to stay unrestricted. The parent adds the child later via
    // `add_allowed_user` from the admin setup UI.
    #[cfg(windows)]
    {
        let is_admin = crate::admin::is_current_process_admin().unwrap_or(false);
        if !is_admin {
            if let Ok(username) = crate::current_user::current_username() {
                if let Err(e) = crate::config::add_allowed_user(&username) {
                    log::warn!("add_allowed_user failed: {e:#}");
                }
            }
        } else {
            log::info!("admin session — skipping auto-add to allowed_users");
        }
    }
    if state.kv_get("device_id").await.map_err(s)?.is_some() {
        lock::overlay::hide(&app).await.map_err(s)?;
        state.set_locked(false, LockReason::Manual).await;
    }
    Ok(())
}

// Admin-only: the setup UI uses this to decide whether to render the admin
// console (allowed_users management + pairing + PIN) or the child lock UX.
#[tauri::command]
pub async fn is_admin_session() -> Result<bool, String> {
    #[cfg(windows)]
    {
        Ok(crate::admin::is_current_process_admin().unwrap_or(false))
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

// List currently permitted child Windows accounts. Kept for back-compat
// with any stale UI code; AdminSetup now uses list_local_users instead so
// it can render display names + admin badges.
#[tauri::command]
pub async fn list_allowed_users() -> Result<Vec<String>, String> {
    let cfg = crate::config::load().map_err(s)?;
    Ok(cfg.allowed_users)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalUserDto {
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
    pub is_current: bool,
    /// True if `username` is already in config.allowed_users (rendered as
    /// toggle-on in the admin picker).
    pub allowed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AllowedUsersPayload {
    pub users: Vec<LocalUserDto>,
    /// Number of allowed_users the subscription permits. `None` = not yet
    /// configured from the web side; UI should hide the cap indicator.
    pub seat_limit: Option<u32>,
    pub seat_used: u32,
}

// Enumerate every enabled local Windows account along with its display
// name + admin status + whether it's already registered as a child. Used
// by AdminSetup to render the picker — replaces the typed-username flow
// from v0.1.9 that forced parents to run `whoami` on each child's login.
#[tauri::command]
pub async fn list_local_users() -> Result<AllowedUsersPayload, String> {
    #[cfg(windows)]
    {
        let cfg = crate::config::load().map_err(s)?;
        let allowed_lc: std::collections::HashSet<String> = cfg
            .allowed_users
            .iter()
            .map(|u| u.to_lowercase())
            .collect();
        let enumerated = crate::users::enumerate().map_err(s)?;
        let users = enumerated
            .into_iter()
            .map(|u| LocalUserDto {
                allowed: allowed_lc.contains(&u.username.to_lowercase()),
                username: u.username,
                display_name: u.display_name,
                is_admin: u.is_admin,
                is_current: u.is_current,
            })
            .collect::<Vec<_>>();
        Ok(AllowedUsersPayload {
            seat_used: cfg.allowed_users.len() as u32,
            users,
            seat_limit: cfg.subscription_seats,
        })
    }
    #[cfg(not(windows))]
    {
        Ok(AllowedUsersPayload { users: vec![], seat_limit: None, seat_used: 0 })
    }
}

// Single entry point for the AdminSetup toggle. `allow=true` adds the user
// to config.allowed_users (gating: can't be an admin, can't exceed the seat
// limit); `allow=false` removes. The "can't be admin" check goes through the
// enumerator instead of trusting the caller — the UI disables admin toggles
// but defense-in-depth prevents a malformed invoke from slipping past.
#[tauri::command]
pub async fn set_allowed_user(username: String, allow: bool) -> Result<(), String> {
    let name = username.trim();
    if name.is_empty() {
        return Err("사용자명이 비어 있습니다".into());
    }

    if !allow {
        crate::config::remove_allowed_user(name).map_err(s)?;
        return Ok(());
    }

    // Allow path: must not be an admin account, must fit in seat budget.
    #[cfg(windows)]
    {
        let local = crate::users::enumerate().map_err(s)?;
        let matched = local
            .iter()
            .find(|u| u.username.eq_ignore_ascii_case(name));
        if let Some(u) = matched {
            if u.is_admin {
                return Err("관리자 계정은 자녀로 등록할 수 없습니다".into());
            }
        }
        // matched=None → user not found in enumeration; still allow the add
        // since offline / not-yet-logged-in accounts may legitimately be
        // missing. The spawner check catches the real gate at runtime.
    }

    let cfg = crate::config::load().map_err(s)?;
    let already = cfg
        .allowed_users
        .iter()
        .any(|u| u.eq_ignore_ascii_case(name));
    if !already {
        if let Some(limit) = cfg.subscription_seats {
            if cfg.allowed_users.len() as u32 >= limit {
                return Err(format!(
                    "구독 seat 한도 ({limit}) 초과. 웹에서 seat 을 늘려주세요."
                ));
            }
        }
    }
    crate::config::add_allowed_user(name).map_err(s)?;
    Ok(())
}

// Left for back-compat; AdminSetup now uses set_allowed_user. Unchanged
// behaviour: ignores seat limit, allows admin accounts — callers beware.
#[tauri::command]
pub async fn add_allowed_user(username: String) -> Result<(), String> {
    let name = username.trim();
    if name.is_empty() {
        return Err("사용자명이 비어 있습니다".into());
    }
    crate::config::add_allowed_user(name).map_err(s)?;
    Ok(())
}

#[tauri::command]
pub async fn remove_allowed_user(username: String) -> Result<(), String> {
    let name = username.trim();
    if name.is_empty() {
        return Err("사용자명이 비어 있습니다".into());
    }
    crate::config::remove_allowed_user(name).map_err(s)
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
    pub agent_version: String,
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

    let version = env!("CARGO_PKG_VERSION").to_string();

    // Priority: one-time-PIN session > daily limit > schedule-window end.
    if let Some(remaining) = state.session_remaining_seconds().await {
        return Ok(Some(TimerInfo {
            kind: "session".into(),
            remaining_seconds: remaining,
            today_used_minutes: used,
            daily_limit_minutes: limit,
            agent_version: version,
        }));
    }

    if limit > 0 && used < limit {
        let remaining_minutes = limit - used;
        return Ok(Some(TimerInfo {
            kind: "daily".into(),
            remaining_seconds: (remaining_minutes as i64) * 60,
            today_used_minutes: used,
            daily_limit_minutes: limit,
            agent_version: version,
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
            agent_version: version,
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
        "unregister" => {
            log::info!("unregister command received; wiping and restarting");
            // Lock screen first so a surprise deregister doesn't leave the PC
            // wide-open between now and the respawn.
            let _ = lock::overlay::show(app).await;
            state.set_locked(true, LockReason::Manual).await;
            state.wipe_all().await?;
            // Give the RTDB consume-ack a moment before we die.
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            std::process::exit(0);
        }
        "uninstallAgent" => {
            log::info!("uninstallAgent command received; launching NSIS uninstaller");
            state.wipe_all().await?;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            // NSIS puts uninstall.exe next to the main exe in the install dir.
            // /S = silent. The uninstaller stops the service (PREUNINSTALL
            // hook), deletes files, removes the service, then deletes itself.
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    let uninstaller = dir.join("uninstall.exe");
                    let _ = std::process::Command::new(&uninstaller).arg("/S").spawn();
                }
            }
            // The uninstaller will kill us when the service stops; exit
            // explicitly in case the spawn above failed.
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            std::process::exit(0);
        }
        "resetTodayUsage" => {
            let today = state.reset_today_usage().await?;
            let date_str = today.format("%Y-%m-%d").to_string();
            // Clear the RTDB snapshot so the parent app sees 0 immediately.
            crate::firebase::clear_usage_day(state, &date_str).await.ok();
        }
        "setPin" => {
            // Web console parent pushes a new main PIN. Replaces the existing
            // one outright — same semantics as the local `set_pin` Tauri
            // command, just triggered from the server side. PIN comes in
            // plaintext so the agent controls hashing (single canonical
            // argon2 format). Clears the one-time-PIN slot so there's no
            // stale temp credential after a main-PIN rotation.
            let pin_str = payload
                .get("pin")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("setPin: missing 'pin'"))?;
            if pin_str.len() < 4 || pin_str.len() > 6 || !pin_str.chars().all(|c| c.is_ascii_digit()) {
                anyhow::bail!("setPin: 4-6 digit numeric PIN required");
            }
            let hash = pin::hash(pin_str)?;
            state.kv_set("pin_hash", &hash).await?;
            state.clear_temp_pin().await.ok();
        }
        "setSeatLimit" => {
            // Subscription seat count pushed from the web console. `None`
            // (null in JSON) clears the limit. AdminSetup reads this through
            // config.load() on every refresh, so no restart needed.
            let seats = payload.get("seats").and_then(Value::as_u64).map(|n| n as u32);
            #[cfg(windows)]
            crate::config::set_subscription_seats(seats)?;
            #[cfg(not(windows))]
            let _ = seats;
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
