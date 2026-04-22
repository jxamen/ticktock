// Library root. `main.rs` dispatches between service / CLI / dev modes and
// delegates to `run_app()` here to start the Tauri event loop.

#[cfg(windows)]
pub mod admin;
pub mod commands;
pub mod config;
#[cfg(windows)]
pub mod current_user;
pub mod firebase;
pub mod lock;
pub mod pairing;
pub mod schedule;
#[cfg(windows)]
pub mod service;
#[cfg(windows)]
pub mod spawner;
#[cfg(windows)]
pub mod service_updater;
pub mod storage;
pub mod updater;
pub mod usage;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_app() {
    tauri::Builder::default()
        // single_instance keeps a second launch of the exe from starting a
        // parallel agent — the handler is intentionally a no-op since there's
        // no UI to focus any more (the overlay/timer are opened by Rust).
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::get_current_state,
            commands::verify_pin_and_unlock,
            commands::set_pin,
            commands::has_pin,
            commands::setup_pin_and_unlock,
            commands::register_device,
            commands::issue_one_time_pin,
            commands::get_timer_info,
            commands::lock_now,
            commands::get_pairing_status,
            commands::get_lock_status,
            commands::is_admin_session,
            commands::list_allowed_users,
            commands::add_allowed_user,
            commands::remove_allowed_user,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = bootstrap(handle).await {
                    log::error!("bootstrap failed: {e:#}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn bootstrap(app: tauri::AppHandle) -> anyhow::Result<()> {
    let state = storage::AppState::load().await?;
    app.manage(state.clone());

    // Per-session guard now lives in spawner.rs — the service refuses to
    // launch a user-session child in any account not listed in
    // config.allowed_users, so by the time we reach bootstrap we know this
    // session is permitted. For dev (tauri:dev has no service in the loop)
    // we fall through unconditionally.

    // Back-compat: earlier builds recorded the primary account in the kv
    // store under `primary_user`. Migrate it into the new config.json once
    // so upgraded installs don't lose their guard, then drop the kv entry.
    #[cfg(windows)]
    if let Ok(Some(legacy)) = state.kv_get("primary_user").await {
        if !legacy.is_empty() {
            if let Err(e) = config::add_allowed_user(&legacy) {
                log::warn!("migrate primary_user → config failed: {e:#}");
            }
        }
        let _ = state.kv_delete("primary_user").await;
    }

    // Admin (parent) sessions: the agent is only meant to restrict the
    // *child*. If the logged-in Windows user is a local administrator we
    // never show the lock overlay — instead a plain setup window opens so
    // the parent can configure PIN / child users / pairing, then close the
    // window and walk away. This is the primary escape hatch from the
    // fail-closed design: a parent who accidentally installs onto their own
    // account must not get trapped.
    #[cfg(windows)]
    let is_admin = if cfg!(debug_assertions) {
        false
    } else {
        match admin::is_current_process_admin() {
            Ok(v) => {
                log::info!("admin check → {v}");
                v
            }
            Err(e) => {
                // Never collapse errors into "not admin" silently — that was
                // the v0.1.7/v0.1.8 silent-false bug where CheckTokenMembership
                // rejected primary tokens and the overlay appeared on the
                // parent's own account.
                log::warn!("admin check failed (treating as non-admin): {e:#}");
                false
            }
        }
    };
    #[cfg(not(windows))]
    let is_admin = false;

    if is_admin {
        log::info!("admin session detected — skipping overlay, opening setup window");
        lock::setup_window::show(&app).await?;
        state.set_locked(false, schedule::LockReason::Manual).await;
    } else if let Some(remaining) = state.session_remaining_seconds().await {
        // Fail-closed: lock on boot by default. But if a one-time-PIN session
        // was in progress when we restarted (persisted in kv), resume it —
        // otherwise the PIN is already consumed and the child would be locked
        // out of their remaining time.
        log::info!("resuming one-time-PIN session on boot ({}s remaining)", remaining);
        state.set_locked(false, schedule::LockReason::Manual).await;
    } else if cfg!(debug_assertions) {
        // Debug builds (`npm run tauri:dev`) start *unlocked*. Dev iterations
        // spawn the process dozens of times — forcing an overlay up on every
        // reload gets in the way and serves no security purpose since dev is
        // behind an unlocked parent account anyway.
        log::info!("debug build — starting unlocked (no boot overlay)");
        state.set_locked(false, schedule::LockReason::Manual).await;
    } else {
        lock::overlay::show(&app).await?;
        state.set_locked(true, schedule::LockReason::Boot).await;
    }

    tokio::spawn(pairing::run_loop(app.clone(), state.clone()));

    if is_admin {
        // Admin session only runs the pairing loop — everything else
        // (schedule ticker, firebase listener, heartbeat, usage poller,
        // timer / overlay watchdogs) exists to enforce restrictions on the
        // child, so running it under the parent's session would either do
        // nothing useful or actively risk locking the parent out.
        return Ok(());
    }

    tokio::spawn(firebase::run_listener(app.clone(), state.clone()));
    tokio::spawn(schedule::run_ticker(app.clone(), state.clone()));
    #[cfg(windows)]
    tokio::spawn(usage::run_poller(app.clone(), state.clone()));
    tokio::spawn(firebase::run_heartbeat(app.clone(), state.clone()));
    tokio::spawn(firebase::run_state_pusher(app.clone(), state.clone()));
    tokio::spawn(lock::timer::run_watcher(app.clone(), state.clone()));
    tokio::spawn(lock::overlay::run_watchdog(app.clone(), state.clone()));
    // Auto-update is handled by the Windows Service (see service_updater.rs);
    // the user-session child never prompts for admin credentials.

    Ok(())
}
