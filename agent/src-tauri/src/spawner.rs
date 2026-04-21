// Spawn a Tauri user-session child process from a Windows Service.
//
// A service runs in Session 0 and cannot draw UI on the interactive desktop.
// The production model is that the service is the durable supervisor — it
// watches for an interactive session and launches a child agent process
// *inside that session* that actually owns the overlay window.
//
// Flow:
//   1. WTSGetActiveConsoleSessionId → the session id currently on the console.
//   2. WTSQueryUserToken(session)   → a primary token for that session's user.
//   3. CreateEnvironmentBlock       → the user-specific env block.
//   4. CreateProcessAsUserW         → spawn our exe with --user-session inside
//                                     that session. The child's stdout/stderr
//                                     are discarded; logs go through env_logger.
//
// Privileges: requires SeTcbPrivilege + SeAssignPrimaryTokenPrivilege.
// LocalSystem (the service account) has both.

#![cfg(windows)]

use anyhow::{bail, Context, Result};
use std::{ffi::OsString, mem, os::windows::ffi::OsStrExt, ptr};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetExitCodeProcess, CREATE_NEW_CONSOLE, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, STARTUPINFOW,
};

pub struct ChildProcess {
    pub process: HANDLE,
    pub thread: HANDLE,
    pub pid: u32,
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        unsafe {
            if !self.process.is_invalid() {
                let _ = CloseHandle(self.process);
            }
            if !self.thread.is_invalid() {
                let _ = CloseHandle(self.thread);
            }
        }
    }
}

pub fn spawn_in_active_session() -> Result<ChildProcess> {
    unsafe {
        let session_id = WTSGetActiveConsoleSessionId();
        // 0xFFFFFFFF = no active session (no user logged in yet).
        if session_id == u32::MAX {
            bail!("no active console session");
        }

        let mut user_token: HANDLE = HANDLE::default();
        WTSQueryUserToken(session_id, &mut user_token).ok()
            .context("WTSQueryUserToken failed (no logged-on user in target session)")?;
        // Ensure the token handle is closed on every path.
        let _token_guard = scopeguard(|| { let _ = CloseHandle(user_token); });

        let mut env_block: *mut std::ffi::c_void = ptr::null_mut();
        CreateEnvironmentBlock(&mut env_block, Some(user_token), false).ok()
            .context("CreateEnvironmentBlock failed")?;
        let _env_guard = scopeguard(|| { let _ = DestroyEnvironmentBlock(env_block); });

        // Command line: "<exe>" --user-session
        let exe = std::env::current_exe().context("current_exe failed")?;
        let mut cmdline = wstr(format!("\"{}\" --user-session", exe.display()));

        let mut startup: STARTUPINFOW = mem::zeroed();
        startup.cb = mem::size_of::<STARTUPINFOW>() as u32;
        // Target the interactive desktop in the user's window station.
        let mut desktop = wstr("winsta0\\default".to_string());
        startup.lpDesktop = PWSTR(desktop.as_mut_ptr());

        let mut pi: PROCESS_INFORMATION = mem::zeroed();
        let sec = SECURITY_ATTRIBUTES {
            nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: ptr::null_mut(),
            bInheritHandle: false.into(),
        };

        CreateProcessAsUserW(
            Some(user_token),
            PCWSTR::null(),
            Some(PWSTR(cmdline.as_mut_ptr())),
            Some(&sec),
            Some(&sec),
            false,
            CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
            Some(env_block),
            PCWSTR::null(),
            &startup,
            &mut pi,
        )
        .ok()
        .context("CreateProcessAsUserW failed")?;

        Ok(ChildProcess {
            process: pi.hProcess,
            thread: pi.hThread,
            pid: pi.dwProcessId,
        })
    }
}

pub fn is_alive(child: &ChildProcess) -> bool {
    unsafe {
        let mut code: u32 = 0;
        if GetExitCodeProcess(child.process, &mut code).is_err() {
            return false;
        }
        // STILL_ACTIVE == 259
        code == 259
    }
}

fn wstr(s: String) -> Vec<u16> {
    let os = OsString::from(s);
    os.encode_wide().chain(std::iter::once(0)).collect()
}

// Tiny scopeguard to avoid pulling in a crate for a two-line cleanup helper.
struct ScopeGuard<F: FnOnce()>(Option<F>);
impl<F: FnOnce()> Drop for ScopeGuard<F> {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}
fn scopeguard<F: FnOnce()>(f: F) -> ScopeGuard<F> {
    ScopeGuard(Some(f))
}
