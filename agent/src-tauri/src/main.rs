#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Entry point. Routes between service-mode (started by SCM) and interactive
// install/uninstall/dev modes. See service.rs for the SCM dispatch loop.

use std::env;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args: Vec<String> = env::args().collect();
    let flag = args.get(1).map(String::as_str);

    #[cfg(windows)]
    match flag {
        Some("--install-service") => {
            ticktock_agent::service::install().expect("install failed");
            return;
        }
        Some("--uninstall-service") => {
            ticktock_agent::service::uninstall().expect("uninstall failed");
            return;
        }
        Some("--service") => {
            // Called by SCM. Hand off to the service dispatcher.
            ticktock_agent::service::run().expect("service exited with error");
            return;
        }
        // Local self-check: run the same admin-detection the bootstrap uses and
        // report the result via MessageBox + %TEMP% log. Lets us validate the
        // fix on a parent account before shipping an installer.
        Some("--check-admin") => {
            ticktock_agent::admin::diagnose();
            return;
        }
        // --user-session is the same as dev mode but with an explicit marker so
        // the service supervisor and us can identify child processes in logs.
        Some("--user-session") => {
            log::info!("running as user-session child");
        }
        _ => {}
    }

    // Interactive / dev mode / user-session child: run the Tauri app directly.
    ticktock_agent::run_app();
}
