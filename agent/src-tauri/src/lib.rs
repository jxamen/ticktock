// Library root. `main.rs` dispatches between service / CLI / dev modes and
// delegates to `run_app()` here to start the Tauri event loop.

pub mod commands;
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
    let state = storage::AppState::load(&app).await?;
    app.manage(state.clone());

    // Restrict the agent to the "primary" Windows account (whichever user
    // first completed PIN setup). Other user sessions that the service
    // spawns us into — e.g. the parent's account — exit quietly so the
    // overlay doesn't follow them around.
    #[cfg(windows)]
    if !cfg!(debug_assertions) {
        if let Ok(current) = current_user::current_username() {
            if let Some(primary) = state.kv_get("primary_user").await.ok().flatten() {
                if !current_user::same_user(&current, &primary) {
                    log::info!(
                        "running as '{current}' but primary user is '{primary}'; exiting"
                    );
                    std::process::exit(0);
                }
            }
        }
    }

    // Fail-closed: lock on boot by default. But if a one-time-PIN session
    // was in progress when we restarted (persisted in kv), resume it —
    // otherwise the PIN is already consumed and the child would be locked
    // out of their remaining time.
    //
    // Exception: debug builds (`npm run tauri:dev`) start *unlocked*. Dev
    // iterations spawn the process dozens of times — forcing an overlay up
    // on every reload gets in the developer's way and serves no security
    // purpose since dev is behind an unlocked parent account anyway.
    if let Some(remaining) = state.session_remaining_seconds().await {
        log::info!("resuming one-time-PIN session on boot ({}s remaining)", remaining);
        state.set_locked(false, schedule::LockReason::Manual).await;
    } else if cfg!(debug_assertions) {
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
