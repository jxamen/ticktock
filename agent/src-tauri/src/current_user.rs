// Fetch the Windows username of the process that's running the agent.
//
// Used to restrict the agent to a single "primary" user (the child account).
// The service spawns a child process in every interactive session it sees,
// including the parent's — without this gate, the overlay would appear when
// the parent logs in, which defeats the purpose.
//
// First-time PIN setup records the current username into the agent's kv
// under `primary_user`. Subsequent boots compare and exit if they don't match.

#![cfg(windows)]

use anyhow::{Context, Result};
use windows::core::PWSTR;
use windows::Win32::System::WindowsProgramming::GetUserNameW;

pub fn current_username() -> Result<String> {
    unsafe {
        let mut len: u32 = 256;
        let mut buf = vec![0u16; len as usize];
        GetUserNameW(Some(PWSTR(buf.as_mut_ptr())), &mut len)
            .ok()
            .context("GetUserNameW failed")?;
        // `len` now includes the trailing NUL; strip it.
        let end = (len as usize).saturating_sub(1);
        Ok(String::from_utf16_lossy(&buf[..end]))
    }
}

pub fn same_user(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}
