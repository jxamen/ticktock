// Library root. `main.rs` dispatches between service / CLI / dev modes and
// delegates to `run_app()` here to start the Tauri event loop.

#[cfg(windows)]
pub mod admin;
#[cfg(windows)]
pub mod child_ctl;
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
#[cfg(windows)]
pub mod users;

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
            commands::list_local_users,
            commands::set_allowed_user,
            commands::add_allowed_user,
            commands::remove_allowed_user,
            commands::child_list_status,
            commands::child_issue_temp_pin,
            commands::child_revoke_temp_pin,
            commands::child_adjust_temp_pin,
            commands::child_grant_bonus,
            commands::child_reset_today_usage,
            commands::child_set_schedule,
            commands::child_clear_main_pin,
            commands::child_usage_history,
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
    // Decide admin vs child BEFORE touching any DB: the two paths don't
    // share state (admin session has no AppState) and a parent account must
    // never open another user's silo or create one for itself.
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

    // Admin (parent) session: no AppState, no overlay, no loops. Just the
    // setup window that manages allowed_users. PIN, pairing, schedule, and
    // usage are all per-child — each child Windows account runs its own
    // agent instance with its own DB and handles those from its own login.
    if is_admin {
        log::info!("admin session — opening setup window, skipping AppState");
        lock::setup_window::show(&app).await?;
        return Ok(());
    }

    // Child session: load the DB silo for *this* Windows account.
    //
    //   %ProgramData%\TickTock\users\{username}\ticktock.sqlite
    //
    // Sibling child accounts on the same PC get their own silos — so
    // separate device_ids (server counts as separate seats), separate
    // PINs, schedules, usage, one-time-PIN state. That's the whole point
    // of the "1 PC, parent + child1/2/3" topology.
    #[cfg(windows)]
    let username = current_user::current_username()?;
    #[cfg(not(windows))]
    let username = String::from("dev");

    let state = storage::AppState::load_for_user(&username).await?;
    app.manage(state.clone());

    // Back-compat: v0.1.x stored the primary account in the migrated legacy
    // DB's kv under `primary_user`. After AppState::load_for_user has
    // adopted that legacy DB (if applicable), promote the kv entry into
    // config.allowed_users so the spawner gate keeps working, then drop it.
    #[cfg(windows)]
    if let Ok(Some(legacy)) = state.kv_get("primary_user").await {
        if !legacy.is_empty() {
            if let Err(e) = config::add_allowed_user(&legacy) {
                log::warn!("migrate primary_user → config failed: {e:#}");
            }
        }
        let _ = state.kv_delete("primary_user").await;
    }

    if let Some(remaining) = state.session_remaining_seconds().await {
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
