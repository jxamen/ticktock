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
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::storage::AppState;

const OVERLAY_LABEL: &str = "overlay";

pub async fn show(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        w.show()?;
        w.unminimize().ok();
        w.set_focus()?;
        return Ok(());
    }

    // Keep the same "real" lock appearance in both dev and prod (fullscreen,
    // topmost, no title bar, hidden from taskbar) — otherwise dev testing
    // doesn't actually exercise the lock UX. The only dev concession is that
    // Alt+F4 / minimize are allowed so the developer can escape, and close
    // requests aren't vetoed.
    let dev = cfg!(debug_assertions);

    let w = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::default())
        .title("TickTock")
        .fullscreen(true)
        .always_on_top(true)
        .decorations(false)
        .skip_taskbar(true)
        .focused(true)
        .visible(true)
        .closable(dev)
        .minimizable(dev)
        .build()?;

    if !dev {
        // Ignore Alt+F4 / system close requests in prod; the overlay is only
        // allowed to go away through verify_pin_and_unlock or a remote unlock.
        w.on_window_event(|event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
        });
    }

    Ok(())
}

/// Periodic foreground-stealing watchdog: if we're supposed to be locked and
/// something else (Win+D, another top-most app, minimize) stole the overlay's
/// place, put it back on top. Only runs while locked — an unlocked state
/// means hide() has put the window off-screen on purpose and we must not
/// drag it back.
pub async fn run_watchdog(app: AppHandle, state: AppState) {
    // Completely disabled in debug — otherwise the watchdog keeps forcing the
    // overlay back to the front while you're trying to debug.
    if cfg!(debug_assertions) {
        return;
    }
    loop {
        tokio::time::sleep(Duration::from_millis(750)).await;
        if !state.is_locked().await {
            continue;
        }
        if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
            ensure_frontmost(&w);
        }
    }
}

fn ensure_frontmost(w: &WebviewWindow) {
    if let Ok(min) = w.is_minimized() {
        if min {
            let _ = w.unminimize();
        }
    }
    if let Ok(visible) = w.is_visible() {
        if !visible {
            let _ = w.show();
        }
    }
    let _ = w.set_always_on_top(true);
    let _ = w.set_focus();
}

pub async fn hide(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        // Close() triggers the CloseRequested event, which prevent_close
        // vetoes — so closing by API path also fails. Use hide() instead:
        // it bypasses the event entirely and we can show() it again later.
        w.hide()?;
    }
    Ok(())
}
