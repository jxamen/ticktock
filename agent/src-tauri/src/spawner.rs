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
use windows::Win32::Security::{
    GetTokenInformation, LookupAccountSidW, SECURITY_ATTRIBUTES, SID_NAME_USE, TokenUser,
    TOKEN_USER,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetExitCodeProcess, TerminateProcess, CREATE_NEW_CONSOLE,
    CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
};

pub struct ChildProcess {
    pub process: HANDLE,
    pub thread: HANDLE,
    pub pid: u32,
    /// The interactive Windows session this child was spawned into.
    /// Used by the supervisor to detect console-session switches (Fast
    /// User Switching) and terminate the stale child so the new console
    /// user gets their own agent instance — otherwise v0.1.10 would
    /// leave a child alive in the previous user's (now-disconnected)
    /// session and the new user never saw an overlay.
    pub session_id: u32,
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

        // allowed_users gate: if the parent's or any other account owns the
        // active session, exit here instead of spawning a child that would
        // just flash an overlay at them before exiting. Fresh installs with
        // an empty list fall through — the first-run UI needs to appear so
        // the parent (or child) can complete PIN setup, after which that
        // account is recorded and the gate starts enforcing.
        let username = username_for_token(user_token)
            .context("resolve username for session token")?;

        // Gate: spawn only for
        //   (a) users in config.allowed_users (the parent's registered
        //       children — they need the overlay), or
        //   (b) local administrator accounts (the parent themselves — they
        //       need AdminSetup).
        // v0.1.11 and earlier had an "empty list → allow everyone"
        // escape hatch that meant toggling the last child off silently
        // re-enabled the overlay for every session on the PC; that's
        // what the user saw when joshu's overlay kept appearing after
        // being toggled off.
        let in_allowed = crate::config::is_in_allowed(&username);
        let is_admin = crate::users::local_admin_names()
            .map(|s| s.iter().any(|a| a.eq_ignore_ascii_case(&username)))
            .unwrap_or_else(|e| {
                log::warn!("admin group lookup failed, treating session as non-admin: {e:#}");
                false
            });
        if !in_allowed && !is_admin {
            bail!(
                "session owned by '{}' — not in allowed_users and not an admin; skipping spawn",
                username
            );
        }

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
            session_id,
        })
    }
}

pub fn active_console_session() -> Option<u32> {
    unsafe {
        let id = WTSGetActiveConsoleSessionId();
        if id == u32::MAX {
            None
        } else {
            Some(id)
        }
    }
}

pub fn terminate(child: &ChildProcess) {
    unsafe {
        let _ = TerminateProcess(child.process, 0);
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

// Resolve the Windows account name ("taehoon", "child1", ...) that owns the
// given session token. Two-step Win32 dance: GetTokenInformation(TokenUser)
// to pull the SID out, then LookupAccountSidW to turn it into a string.
unsafe fn username_for_token(token: HANDLE) -> Result<String> {
    // First call sizes the buffer; the expected error is ERROR_INSUFFICIENT_BUFFER.
    let mut needed: u32 = 0;
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
    if needed == 0 {
        bail!("GetTokenInformation(TokenUser) returned zero size");
    }
    let mut buf = vec![0u8; needed as usize];
    GetTokenInformation(
        token,
        TokenUser,
        Some(buf.as_mut_ptr() as *mut _),
        needed,
        &mut needed,
    )
    .ok()
    .context("GetTokenInformation(TokenUser)")?;

    let tu = &*(buf.as_ptr() as *const TOKEN_USER);
    let sid = tu.User.Sid;

    // Size again — LookupAccountSidW returns the required lengths via
    // ERROR_INSUFFICIENT_BUFFER on the first call.
    let mut name_len: u32 = 0;
    let mut domain_len: u32 = 0;
    let mut sid_type: SID_NAME_USE = SID_NAME_USE::default();
    let _ = LookupAccountSidW(
        PCWSTR::null(),
        sid,
        None,
        &mut name_len,
        None,
        &mut domain_len,
        &mut sid_type,
    );
    if name_len == 0 {
        bail!("LookupAccountSidW returned zero name length");
    }
    let mut name = vec![0u16; name_len as usize];
    let mut domain = vec![0u16; domain_len.max(1) as usize];
    LookupAccountSidW(
        PCWSTR::null(),
        sid,
        Some(PWSTR(name.as_mut_ptr())),
        &mut name_len,
        Some(PWSTR(domain.as_mut_ptr())),
        &mut domain_len,
        &mut sid_type,
    )
    .ok()
    .context("LookupAccountSidW")?;

    // name_len comes back as the count *without* the terminating NUL.
    let end = name_len as usize;
    Ok(String::from_utf16_lossy(&name[..end]))
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
