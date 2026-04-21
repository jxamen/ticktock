// Small always-on-top countdown window shown at the bottom-right of the primary
// monitor. Shown while a one-time-PIN session is active so the child can see
// remaining time; hidden otherwise.

use anyhow::Result;
use std::time::Duration;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{schedule, storage::AppState};

const TIMER_LABEL: &str = "timer";
const TIMER_W: f64 = 240.0;
const TIMER_H: f64 = 108.0;
const SIDE_MARGIN: f64 = 16.0;
// Extra reserved area for the Windows taskbar (40-48px at common DPI) + a
// small visual gap so the countdown sits above it rather than behind it.
// Tauri 2's Monitor API doesn't expose the work area cross-platform yet.
const BOTTOM_MARGIN: f64 = 72.0;

pub async fn show(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window(TIMER_LABEL) {
        // Respect a user-minimized window: don't pop back up while it's
        // intentionally parked in the taskbar. position+show is only for
        // re-emerging from a hidden state (e.g. after lock → unlock).
        if w.is_minimized().unwrap_or(false) {
            return Ok(());
        }
        position_bottom_right(&w)?;
        w.show()?;
        return Ok(());
    }

    let w = WebviewWindowBuilder::new(app, TIMER_LABEL, WebviewUrl::default())
        .title("TickTock")
        .inner_size(TIMER_W, TIMER_H)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        // Keep the taskbar icon so the child can restore the timer after
        // minimizing it — minimizing it "내린다" is the UX they expect.
        .skip_taskbar(false)
        .minimizable(true)
        .focused(false)
        .visible(false)
        .build()?;

    position_bottom_right(&w)?;
    w.show()?;
    Ok(())
}

pub async fn hide(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window(TIMER_LABEL) {
        w.hide()?;
    }
    Ok(())
}

// Keep the countdown window's visibility in sync with whether there is
// anything worth counting down. Runs for the life of the app, reacting to
// state-change notifications and polling every 5s for time-driven transitions.
pub async fn run_watcher(app: AppHandle, state: AppState) {
    loop {
        let visible = compute_should_show(&state).await;
        if visible {
            let _ = show(&app).await;
        } else {
            let _ = hide(&app).await;
        }
        tokio::select! {
            _ = state.wait_state_changed() => {}
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
    }
}

async fn compute_should_show(state: &AppState) -> bool {
    // No countdown makes sense while the overlay is covering the screen.
    if state.is_locked().await {
        return false;
    }
    if state.session_remaining_seconds().await.is_some() {
        return true;
    }
    let sched = state.current_schedule().await;
    let used = state.today_used_minutes().await;
    if sched.daily_limit_minutes > 0 && used < sched.daily_limit_minutes {
        return true;
    }
    let tz = state.timezone().await;
    let now = chrono::Utc::now().with_timezone(&tz);
    schedule::current_window_remaining_seconds(&sched, now).is_some()
}

fn position_bottom_right(w: &tauri::WebviewWindow) -> Result<()> {
    if let Some(monitor) = w.current_monitor()?.or(w.primary_monitor()?) {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        // Monitor size is physical; convert to logical for positioning.
        let logical_w = size.width as f64 / scale;
        let logical_h = size.height as f64 / scale;
        let x = logical_w - TIMER_W - SIDE_MARGIN;
        let y = logical_h - TIMER_H - BOTTOM_MARGIN;
        w.set_size(LogicalSize::new(TIMER_W, TIMER_H))?;
        w.set_position(LogicalPosition::new(x, y))?;
    }
    Ok(())
}
