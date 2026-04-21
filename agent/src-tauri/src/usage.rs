// Foreground usage poller. Windows-only; the whole agent targets Windows.
//
// Tick every 2s:
//   1. idle? if GetLastInputInfo says > 60s since last input, close open session.
//   2. Query foreground window -> process name + exe path + window title.
//   3. Skip if foreground is our own overlay process (avoid self-counting).
//   4. Delegate to AppState::extend_or_open_session.

#![cfg(windows)]

use anyhow::Result;
use std::{os::windows::ffi::OsStringExt, time::Duration};
use tauri::AppHandle;
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE, HWND},
    System::{
        ProcessStatus::GetModuleFileNameExW,
        SystemInformation::GetTickCount,
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    UI::{
        Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
        WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId},
    },
};

use crate::storage::AppState;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const IDLE_THRESHOLD_SECS: u32 = 60;

#[derive(Clone, Debug)]
pub struct ForegroundInfo {
    pub process_name: String,
    pub exe_path: String,
    pub window_title: String,
    pub pid: u32,
}

pub async fn run_poller(_app: AppHandle, state: AppState) {
    let mut interval = tokio::time::interval(POLL_INTERVAL);
    let self_pid = std::process::id();
    loop {
        interval.tick().await;
        if let Err(e) = tick(&state, self_pid).await {
            log::warn!("usage tick error: {e:#}");
        }
    }
}

async fn tick(state: &AppState, self_pid: u32) -> Result<()> {
    match idle_seconds() {
        Ok(idle) if idle >= IDLE_THRESHOLD_SECS => {
            state.close_open_session().await?;
            return Ok(());
        }
        Err(e) => log::debug!("idle read failed: {e}"),
        _ => {}
    }

    let Some(info) = foreground_process()? else { return Ok(()) };
    if info.pid == self_pid {
        return Ok(());
    }
    state.extend_or_open_session(info).await?;
    Ok(())
}

fn foreground_process() -> Result<Option<ForegroundInfo>> {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return Ok(None);
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return Ok(None);
        }
        let title = read_window_title(hwnd);
        let Ok((exe_path, process_name)) = read_process_image(pid) else {
            return Ok(None); // access denied for elevated procs; skip
        };
        Ok(Some(ForegroundInfo { process_name, exe_path, window_title: title, pid }))
    }
}

unsafe fn read_window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

unsafe fn read_process_image(pid: u32) -> Result<(String, String)> {
    let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)?;
    let mut buf = [0u16; 1024];
    let len = GetModuleFileNameExW(Some(handle), None, &mut buf);
    let _ = CloseHandle(handle);
    if len == 0 {
        anyhow::bail!("GetModuleFileNameExW returned 0");
    }
    let exe_path = std::ffi::OsString::from_wide(&buf[..len as usize])
        .to_string_lossy()
        .to_string();
    let process_name = std::path::Path::new(&exe_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| exe_path.clone());
    Ok((exe_path, process_name))
}

fn idle_seconds() -> Result<u32> {
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        GetLastInputInfo(&mut info).ok()?;
        let tick = GetTickCount();
        // GetTickCount wraps at 49.7 days; u32 subtraction handles wrap correctly.
        Ok(tick.wrapping_sub(info.dwTime) / 1000)
    }
}
