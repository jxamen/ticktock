// Windows Service lifecycle: install, uninstall, run-under-SCM.
//
// Recovery options ensure the service restarts if killed — load-bearing for
// the security model (overlay is the only lock gate).
//
// ***Session-0 caveat***: a Windows Service runs in session 0, which cannot
// display UI to the interactive desktop. The Tauri overlay has to live in the
// user session. The production plan:
//
//   1. Service process (this dispatcher) watches WTS session notifications.
//   2. On session logon / unlock, it calls WTSQueryUserToken + CreateProcessAsUser
//      to spawn a child "user-session" agent process in that session.
//   3. The child runs the Tauri app (lib::run_app) and owns the overlay window.
//   4. If the child dies, service respawns it.
//   5. Service <-> child communicate over a named pipe for command routing.
//
// That piece is NOT implemented yet — tracked in CLAUDE.md follow-ups.
// For v0.1 development we run the Tauri app directly (no service install),
// and the CLAUDE.md deployment section notes this limitation.

#![cfg(windows)]

use anyhow::Result;
use std::{ffi::OsString, time::Duration};
use windows_service::{
    define_windows_service,
    service::{
        ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
        ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
        ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
    service_manager::{ServiceManager, ServiceManagerAccess},
};

pub const SERVICE_NAME: &str = "TickTockAgent";
pub const SERVICE_DISPLAY: &str = "TickTock Agent";
pub const SERVICE_DESCRIPTION: &str = "Enforces parental PC usage rules.";

pub fn install() -> Result<()> {
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CREATE_SERVICE | ServiceManagerAccess::CONNECT,
    )?;

    let exe = std::env::current_exe()?;
    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe,
        launch_arguments: vec![OsString::from("--service")],
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };

    let service = manager.create_service(
        &info,
        ServiceAccess::CHANGE_CONFIG | ServiceAccess::START,
    )?;
    service.set_description(SERVICE_DESCRIPTION)?;

    let actions = ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86400)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![
            ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(1) },
            ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(5) },
            ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(15) },
        ]),
    };
    service.update_failure_actions(actions)?;
    service.start::<&str>(&[])?;

    log::info!("service installed and started");
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service = manager.open_service(
        SERVICE_NAME,
        ServiceAccess::DELETE | ServiceAccess::STOP | ServiceAccess::QUERY_STATUS,
    )?;
    let _ = service.stop();
    service.delete()?;
    log::info!("service uninstalled");
    Ok(())
}

pub fn run() -> Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
    Ok(())
}

define_windows_service!(ffi_service_main, service_main);

fn service_main(_args: Vec<OsString>) {
    if let Err(e) = run_service() {
        log::error!("service failed: {e:#}");
    }
}

fn run_service() -> Result<()> {
    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel::<()>();

    let event_handler = move |control: ServiceControl| -> ServiceControlHandlerResult {
        match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = shutdown_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;

    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::ZERO,
        process_id: None,
    })?;

    // Shared %ProgramData%\TickTock directory + ACL. The service runs as
    // LocalSystem (the only principal on the box that can mkdir under
    // ProgramData *and* edit the DACL without UAC), so do it here before
    // spawning user-session children that will need to read/write the DB.
    if let Err(e) = crate::config::ensure_dir_with_acl() {
        log::warn!("failed to prepare ProgramData dir: {e:#}");
    }

    // Service-side auto-updater: a dedicated thread polls GitHub Releases,
    // verifies the signature, and runs the installer silently (LocalSystem →
    // no UAC). Runs in parallel with the child supervisor.
    let (upd_tx, upd_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || crate::service_updater::run_updater(upd_rx));

    supervise_user_session_child(&shutdown_rx);

    // Ask updater to stop along with the service.
    let _ = upd_tx.send(());

    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::ZERO,
        process_id: None,
    })?;
    Ok(())
}

// Supervise a `--user-session` child process that runs the Tauri app inside
// the currently-active interactive session. Restart it if it dies; spawn it
// the first time a user logs in. Stops cleanly when the SCM asks us to.
fn supervise_user_session_child(shutdown_rx: &std::sync::mpsc::Receiver<()>) {
    use crate::spawner;

    let mut child: Option<spawner::ChildProcess> = None;
    loop {
        // Drop dead children.
        if let Some(c) = &child {
            if !spawner::is_alive(c) {
                log::info!("user-session child exited; will respawn");
                child = None;
            }
        }
        // Spawn if we don't have a live child and a session is available.
        if child.is_none() {
            match spawner::spawn_in_active_session() {
                Ok(c) => {
                    log::info!("spawned user-session child pid={}", c.pid);
                    child = Some(c);
                }
                Err(e) => {
                    log::debug!("cannot spawn yet (no active session?): {e:#}");
                }
            }
        }

        // Poll for shutdown with a 500ms timeout — tight enough that a
        // Task-Manager kill of the child is re-spawned almost immediately,
        // still cheap (each tick is one GetExitCodeProcess call).
        match shutdown_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
        }
    }

    // Service is stopping — let the child exit by itself (it has its own
    // graceful-shutdown paths). Dropping the handle closes the kernel handles.
    drop(child);
}
