// Periodic auto-update check.
//
// Uses tauri-plugin-updater to fetch the latest.json manifest, verify the
// Ed25519 signature, download, and install. Runs a first check 60s after
// boot (let SSE/heartbeat settle) then every 6 hours.
//
// Install mode is "passive" (see tauri.conf.json) so the NSIS installer
// runs silently; the elevated service stays up across the upgrade because
// the NSIS hook re-installs the service on completion.

use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

pub async fn run_watcher(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(60)).await;
    loop {
        if let Err(e) = check_once(&app).await {
            log::warn!("updater check failed: {e:#}");
        }
        tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
    }
}

async fn check_once(app: &AppHandle) -> anyhow::Result<()> {
    let updater = app.updater()?;
    let Some(update) = updater.check().await? else {
        log::debug!("updater: up to date");
        return Ok(());
    };
    log::info!("updater: downloading update {}", update.version);
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                if let Some(total) = total {
                    log::debug!("updater: {}/{} bytes", downloaded, total);
                }
            },
            || log::info!("updater: download complete, launching installer"),
        )
        .await?;
    // The installer will restart the app; we return here and let it happen.
    Ok(())
}
