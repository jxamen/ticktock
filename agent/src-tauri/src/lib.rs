// Library root. `main.rs` dispatches between service / CLI / dev modes and
// delegates to `run_app()` here to start the Tauri event loop.

pub mod commands;
pub mod firebase;
pub mod lock;
pub mod pairing;
pub mod schedule;
#[cfg(windows)]
pub mod service;
#[cfg(windows)]
pub mod spawner;
pub mod storage;
pub mod updater;
pub mod usage;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_app() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("tray") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
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

    // Fail-closed: lock on boot by default. But if a one-time-PIN session
    // was in progress when we restarted (persisted in kv), resume it —
    // otherwise the PIN is already consumed and the child would be locked
    // out of their remaining time.
    if let Some(remaining) = state.session_remaining_seconds().await {
        log::info!("resuming one-time-PIN session on boot ({}s remaining)", remaining);
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
    tokio::spawn(updater::run_watcher(app.clone()));

    Ok(())
}
