// Is the current process running under a Windows user that belongs to the
// local Administrators group?
//
// Why we need this: parents (Windows administrators) should be able to install
// TickTock and complete the setup (PIN + add-child-user + pairing) from their
// own account without ever seeing the fullscreen lock overlay. Only the
// child's standard-user session should get the overlay.
//
// The tricky part is UAC: when an administrator launches the agent from a
// non-elevated shell (or the service spawns a user-session child via
// WTSQueryUserToken), the process token is a *filtered* token with the
// Administrators group marked "deny only" — a membership check on that token
// returns false. Windows stores the unfiltered elevated token as the "linked
// token"; we pull that and re-check, so the answer matches the intuitive
// "is this user an admin on this box?"
//
// Implementation notes (both matter — v0.1.7/0.1.8 got them wrong):
//   * CheckTokenMembership **requires an impersonation token** for its
//     TokenHandle parameter. Passing our process primary token returns
//     ERROR_NO_IMPERSONATION_TOKEN (0x8007051D). Workaround: pass NULL for
//     the first check; CheckTokenMembership then uses the calling thread's
//     token, duplicating the primary to impersonation internally.
//   * The linked token returned by GetTokenInformation(TokenLinkedToken)
//     without SeTcbPrivilege is already an impersonation token but at
//     SecurityIdentification level. Trying to DuplicateTokenEx it up to
//     SecurityImpersonation fails with ERROR_BAD_IMPERSONATION_LEVEL
//     (0x80070542). It's already good enough to hand to CheckTokenMembership
//     directly — no duplication needed.

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
        let sid_storage = AdminSid::new()?;
        let sid = sid_storage.as_psid();

        // First pass: check the current thread's token. CheckTokenMembership
        // with a NULL token_handle uses the thread's impersonation token, and
        // if the thread isn't impersonating it internally duplicates the
        // process primary token into an impersonation token — so this matches
        // "is this process's user an admin on the (possibly UAC-filtered)
        // token it's currently running with".
        let mut is_member = BOOL(0);
        CheckTokenMembership(None, sid, &mut is_member)
            .context("CheckTokenMembership(current thread)")?;
        if is_member.as_bool() {
            return Ok(true);
        }

        // Second pass: UAC-filtered admin token hides the Administrators
        // group as deny-only. The "linked" token is the unfiltered variant;
        // fetch it and check again. Linked token comes back as an
        // impersonation token (usually SecurityIdentification level) which
        // is fine for CheckTokenMembership.
        let mut proc_token: HANDLE = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut proc_token)
            .context("OpenProcessToken")?;
        let _g_proc = CloseGuard(proc_token);

        if let Some(linked) = linked_token(proc_token)? {
            let _g_linked = CloseGuard(linked);
            let mut is_member_linked = BOOL(0);
            CheckTokenMembership(Some(linked), sid, &mut is_member_linked)
                .context("CheckTokenMembership(linked)")?;
            return Ok(is_member_linked.as_bool());
        }

        Ok(false)
    }
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

// SID for the local Administrators group. Heap-less storage (68-byte buffer
// sized to SECURITY_MAX_SID_SIZE) so callers can hold it across membership
// checks without reinitialising.
struct AdminSid {
    buf: [u8; SECURITY_MAX_SID_SIZE as usize],
}

impl AdminSid {
    fn new() -> Result<Self> {
        let mut me = Self {
            buf: [0u8; SECURITY_MAX_SID_SIZE as usize],
        };
        let mut size = SECURITY_MAX_SID_SIZE;
        unsafe {
            CreateWellKnownSid(
                WinBuiltinAdministratorsSid,
                None,
                Some(PSID(me.buf.as_mut_ptr() as *mut _)),
                &mut size,
            )
            .context("CreateWellKnownSid(BuiltinAdmins)")?;
        }
        Ok(me)
    }

    fn as_psid(&self) -> PSID {
        PSID(self.buf.as_ptr() as *mut _)
    }
}

struct CloseGuard(HANDLE);
impl Drop for CloseGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

// Diagnostic entry point for `--check-admin` CLI flag. Runs the same
// detection the bootstrap uses, plus surrounding context (username,
// token-linked-token availability), and reports it through both a
// MessageBox (reliable on windows_subsystem = "windows" builds) and
// a plain text file in %TEMP%.
pub fn diagnose() {
    let username = crate::current_user::current_username()
        .unwrap_or_else(|e| format!("<err: {e:#}>"));

    // Per-step breakdown, independent of is_current_process_admin, so
    // failures in one leg still give us info about the others.
    let thread_check = unsafe {
        let sid = match AdminSid::new() {
            Ok(s) => s,
            Err(e) => return diagnose_render(&username, Err(e), None, None),
        };
        let mut is_member = BOOL(0);
        CheckTokenMembership(None, sid.as_psid(), &mut is_member)
            .map(|()| is_member.as_bool())
            .map_err(anyhow::Error::from)
    };

    let linked_info = unsafe {
        let mut proc_token: HANDLE = HANDLE::default();
        match OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut proc_token) {
            Ok(()) => {
                let _g = CloseGuard(proc_token);
                match linked_token(proc_token) {
                    Ok(Some(linked)) => {
                        let _gl = CloseGuard(linked);
                        let sid = match AdminSid::new() {
                            Ok(s) => s,
                            Err(e) => return diagnose_render(&username, Ok(false), None, Some(Err(e))),
                        };
                        let mut m = BOOL(0);
                        let r = CheckTokenMembership(Some(linked), sid.as_psid(), &mut m)
                            .map(|()| m.as_bool())
                            .map_err(anyhow::Error::from);
                        Some(r)
                    }
                    Ok(None) => None,
                    Err(e) => Some(Err(e)),
                }
            }
            Err(e) => Some(Err(anyhow::Error::from(e).context("OpenProcessToken"))),
        }
    };

    let final_result = is_current_process_admin();
    diagnose_render(&username, thread_check, Some(final_result), linked_info);
}

fn diagnose_render(
    username: &str,
    thread: Result<bool>,
    final_result: Option<Result<bool>>,
    linked: Option<Result<bool>>,
) {
    let mut body = String::new();
    body.push_str("TickTock — admin 감지 진단\n");
    body.push_str("================================\n");
    body.push_str(&format!("Windows 사용자: {username}\n\n"));

    body.push_str(&match &thread {
        Ok(true) => "thread(current) admin check: TRUE (이미 elevated 또는 UAC off)\n".to_string(),
        Ok(false) => "thread(current) admin check: FALSE (UAC-filtered 일 수 있음)\n".to_string(),
        Err(e) => format!("thread(current) admin check 실패: {e:#}\n"),
    });

    body.push_str(&match &linked {
        None => "linked (elevated) token: 없음\n".to_string(),
        Some(Ok(true)) => "linked (elevated) token admin check: TRUE\n".to_string(),
        Some(Ok(false)) => "linked (elevated) token admin check: FALSE\n".to_string(),
        Some(Err(e)) => format!("linked token 처리 실패: {e:#}\n"),
    });

    body.push_str("\n--------------------------------\n");
    match &final_result {
        Some(Ok(true)) => body.push_str(
            "최종: 관리자 ✓\n\n설치 시 overlay 대신 설정 창이 떠야 합니다.",
        ),
        Some(Ok(false)) => body.push_str(
            "최종: 표준 사용자 (관리자 아님)\n\n설치 시 lock overlay 가 뜹니다.",
        ),
        Some(Err(e)) => body.push_str(&format!("최종: 에러 → {e:#}")),
        None => body.push_str("최종: 미평가 (진단 도중 실패)"),
    }

    let file_path = std::env::temp_dir().join("ticktock-admin-check.txt");
    let _ = std::fs::write(&file_path, &body);

    unsafe {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONINFORMATION, MB_OK,
        };
        let title = HSTRING::from("TickTock — 관리자 감지 확인");
        let msg = HSTRING::from(format!(
            "{body}\n\n전체 로그: {}",
            file_path.display()
        ));
        MessageBoxW(None, &msg, &title, MB_OK | MB_ICONINFORMATION);
    }
}
