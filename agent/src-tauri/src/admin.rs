// Is the current process running under a Windows user that belongs to the
// local Administrators group?
//
// Why we need this: parents (Windows administrators) should be able to install
// TickTock and complete the setup (PIN + add-child-user + pairing) from their
// own account without ever seeing the fullscreen lock overlay. Only the
// child's standard-user session should get the overlay.
//
// The tricky part is UAC: when an administrator launches the agent from a
// non-elevated shell, the process token is a *filtered* token with the
// Administrators group marked "deny only" — CheckTokenMembership on that
// token returns false. Windows stores the unfiltered elevated token as the
// "linked token"; we pull that and re-check, so the answer matches the
// intuitive "is this user an admin on this box?"

#![cfg(windows)]

use anyhow::{Context, Result};
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    CheckTokenMembership, CreateWellKnownSid, GetTokenInformation, TokenLinkedToken,
    WinBuiltinAdministratorsSid, PSID, TOKEN_LINKED_TOKEN, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const SECURITY_MAX_SID_SIZE: u32 = 68;

pub fn is_current_process_admin() -> Result<bool> {
    unsafe {
        let mut token: HANDLE = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .context("OpenProcessToken")?;
        let _guard = CloseGuard(token);
        is_token_admin(token)
    }
}

unsafe fn is_token_admin(token: HANDLE) -> Result<bool> {
    if check_admin_membership(token)? {
        return Ok(true);
    }
    // UAC-filtered tokens hide the Administrators group behind the linked
    // elevated token; fall back to checking that one if it exists.
    if let Some(linked) = linked_token(token)? {
        let _g = CloseGuard(linked);
        return check_admin_membership(linked);
    }
    Ok(false)
}

unsafe fn check_admin_membership(token: HANDLE) -> Result<bool> {
    let mut sid_buf = [0u8; SECURITY_MAX_SID_SIZE as usize];
    let mut sid_size = SECURITY_MAX_SID_SIZE;
    let sid = PSID(sid_buf.as_mut_ptr() as *mut _);
    CreateWellKnownSid(WinBuiltinAdministratorsSid, None, Some(sid), &mut sid_size)
        .context("CreateWellKnownSid(BuiltinAdmins)")?;
    let mut is_member = BOOL(0);
    CheckTokenMembership(Some(token), sid, &mut is_member).context("CheckTokenMembership")?;
    Ok(is_member.as_bool())
}

unsafe fn linked_token(token: HANDLE) -> Result<Option<HANDLE>> {
    // TokenLinkedToken returns a TOKEN_LINKED_TOKEN struct (single HANDLE
    // field). If the token has no linked token (e.g. a genuine standard
    // user, or the already-elevated side) GetTokenInformation fails — we
    // treat any failure here as "no linked token available".
    let mut linked = TOKEN_LINKED_TOKEN {
        LinkedToken: HANDLE::default(),
    };
    let mut needed: u32 = 0;
    let ok = GetTokenInformation(
        token,
        TokenLinkedToken,
        Some(&mut linked as *mut _ as *mut _),
        std::mem::size_of::<TOKEN_LINKED_TOKEN>() as u32,
        &mut needed,
    );
    if ok.is_err() || linked.LinkedToken.is_invalid() {
        return Ok(None);
    }
    Ok(Some(linked.LinkedToken))
}

struct CloseGuard(HANDLE);
impl Drop for CloseGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
