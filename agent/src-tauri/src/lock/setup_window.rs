// Admin setup window.
//
// Distinct from the lock overlay: this is a normal, closable, non-topmost
// window that opens in the parent's (administrator's) Windows session so
// they can configure the agent — set/change the PIN, add/remove child
// usernames in config.allowed_users, and complete pairing with the mobile
// app. Closing it just ends the agent process for that session; nothing
// restricts the parent.
//
// Label is "admin" so the UI bundle (same React bundle as overlay/timer)
// can branch on `getCurrentWindow().label` to render the admin view.

use anyhow::Result;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const ADMIN_LABEL: &str = "admin";

pub async fn show(app: &AppHandle) -> Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(ADMIN_LABEL) {
        w.show()?;
        w.unminimize().ok();
        w.set_focus()?;
        return Ok(w);
    }

    let w = WebviewWindowBuilder::new(app, ADMIN_LABEL, WebviewUrl::default())
        .title("TickTock — 관리자 설정")
        .inner_size(720.0, 640.0)
        .min_inner_size(560.0, 520.0)
        .resizable(true)
        .decorations(true)
        .closable(true)
        .minimizable(true)
        .maximizable(true)
        .skip_taskbar(false)
        .always_on_top(false)
        .visible(true)
        .center()
        .build()?;

    // "Close" only hides the window — the process stays alive so the
    // service supervisor doesn't respawn it a few seconds later and make
    // close feel broken. The parent can re-open from the taskbar, or log
    // off / uninstall normally if they really want it gone.
    let w_clone = w.clone();
    w.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let _ = w_clone.hide();
            api.prevent_close();
        }
    });

    Ok(w)
}
