// Full-screen lock overlay window. This is the primary lock mechanism.
//
// Window flags we rely on:
//   - fullscreen + always_on_top     : cannot be escaped with Alt+Tab alone
//   - decorations: false             : no close/minimize buttons
//   - skip_taskbar: true             : invisible to alt-tab's taskbar items
//   - focused on every show          : prevents focus stealing by other apps
//
// Future hardening (TODO):
//   - Block Ctrl+Alt+Del via Secure Attention Sequence... not possible from userspace;
//     accept this gap, detect lock screen via WTS session events and re-show.
//   - Poll foreground window every 500ms; if our overlay lost focus, SetForegroundWindow.

use anyhow::Result;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const OVERLAY_LABEL: &str = "overlay";

pub async fn show(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }

    let _w = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::default())
        .title("TickTock")
        .fullscreen(true)
        .always_on_top(true)
        .decorations(false)
        .skip_taskbar(true)
        .focused(true)
        .visible(true)
        .build()?;

    Ok(())
}

pub async fn hide(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        w.close()?;
    }
    Ok(())
}
