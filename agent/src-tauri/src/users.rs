// Enumerate local Windows user accounts for the admin setup UI.
//
// Previously the parent had to type the child's SAM username into a text field,
// which meant running `whoami` in cmd on the child account first — terrible UX
// on top of being error-prone (MS-account-linked Windows accounts have an
// internal SAM name like "matth" that is *not* the displayed "Matthew Kim").
// This module returns every enabled local account so the UI can render a
// picker with display names + admin/standard badges.
//
// APIs used (all from netapi32.dll, unchanged since Windows 2000):
//   - NetUserEnum(Level=2, FILTER_NORMAL_ACCOUNT)
//       → USER_INFO_2 per user: usri2_name (SAM), usri2_full_name (display),
//         usri2_flags (UF_ACCOUNTDISABLE mask), usri2_priv
//   - NetLocalGroupGetMembers("Administrators", Level=1)
//       → list of member names; we union these with the enumerated users
//         because USER_PRIV_ADMIN on USER_INFO_2 can be stale/wrong for
//         MS-account-linked users whose admin rights come from group
//         membership synced from the online account rather than the local
//         privilege field.

#![cfg(windows)]

use anyhow::{bail, Context, Result};
use std::collections::HashSet;

use windows::core::PWSTR;
use windows::Win32::NetworkManagement::NetManagement::{
    NetApiBufferFree, NetLocalGroupGetMembers, NetUserEnum, FILTER_NORMAL_ACCOUNT,
    LOCALGROUP_MEMBERS_INFO_1, UF_ACCOUNTDISABLE, USER_INFO_2, USER_PRIV_ADMIN,
};

// Windows' built-in accounts we never want to show in the picker. Case-
// insensitive match on the SAM name. DefaultAccount / WDAGUtilityAccount are
// system-managed and invisible in Settings; Guest is (almost always) disabled
// but filtered on name too for safety; Administrator is the built-in admin
// which on MS-Windows consumer SKUs is disabled by default anyway.
const SYSTEM_ACCOUNTS: &[&str] = &[
    "administrator",
    "guest",
    "defaultaccount",
    "wdagutilityaccount",
];

#[derive(Debug, Clone)]
pub struct LocalUser {
    /// SAM username — the value that goes into allowed_users / per-user DB
    /// paths. Stable, case-insensitive.
    pub username: String,
    /// Human-readable name Windows shows on the sign-in screen. For
    /// MS-account-linked users this is synced from the online account
    /// ("Matthew Kim"); for purely local accounts it's the "full name"
    /// the admin typed when creating the account. Can be empty — UI must
    /// fall back to username in that case.
    pub display_name: String,
    /// True if the account is a member of the local Administrators group.
    pub is_admin: bool,
    /// True if this is the Windows user the agent itself is running as.
    /// Used by the UI to highlight "나" and prevent footguns like the
    /// parent accidentally adding themselves to allowed_users.
    pub is_current: bool,
}

pub fn enumerate() -> Result<Vec<LocalUser>> {
    let admin_names = local_admin_names().unwrap_or_else(|e| {
        log::warn!("NetLocalGroupGetMembers(Administrators) failed, is_admin will be false for all: {e:#}");
        HashSet::new()
    });
    let current = crate::current_user::current_username().ok();

    let mut users = Vec::new();
    unsafe {
        let mut buf_ptr: *mut u8 = std::ptr::null_mut();
        let mut entries_read: u32 = 0;
        let mut total_entries: u32 = 0;
        let mut resume: u32 = 0;

        // Level 2 returns USER_INFO_2 with full_name; FILTER_NORMAL_ACCOUNT
        // excludes machine / trust / temp-duplicate accounts that sometimes
        // show up on domain-joined boxes. -1 for prefmaxlen = give us
        // everything in one call.
        loop {
            let rc = NetUserEnum(
                None,
                2,
                FILTER_NORMAL_ACCOUNT,
                &mut buf_ptr,
                u32::MAX,
                &mut entries_read,
                &mut total_entries,
                Some(&mut resume),
            );
            // 0 = NERR_Success, 234 = ERROR_MORE_DATA (need another call with resume).
            if rc != 0 && rc != 234 {
                bail!("NetUserEnum failed with code {rc}");
            }

            let _guard = BufferGuard(buf_ptr as *const _);
            let slice = std::slice::from_raw_parts(buf_ptr as *const USER_INFO_2, entries_read as usize);
            for entry in slice {
                // Disabled accounts — skip. UF_ACCOUNTDISABLE mask = 0x0002.
                if (entry.usri2_flags.0 & UF_ACCOUNTDISABLE.0) != 0 {
                    continue;
                }
                let username = pwstr_to_string(entry.usri2_name);
                if SYSTEM_ACCOUNTS
                    .iter()
                    .any(|s| s.eq_ignore_ascii_case(&username))
                {
                    continue;
                }
                let display_name = pwstr_to_string(entry.usri2_full_name);

                let is_admin = entry.usri2_priv == USER_PRIV_ADMIN
                    || admin_names.iter().any(|a| a.eq_ignore_ascii_case(&username));
                let is_current = current
                    .as_ref()
                    .map(|c| c.eq_ignore_ascii_case(&username))
                    .unwrap_or(false);

                users.push(LocalUser {
                    username,
                    display_name,
                    is_admin,
                    is_current,
                });
            }

            if rc == 0 {
                break;
            }
            // ERROR_MORE_DATA: loop again with the returned resume cookie.
        }
    }

    // Sort: current user first (easiest "myself" visual anchor), then
    // non-admins before admins (children on top, parents below), then
    // display name.
    users.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(a.is_admin.cmp(&b.is_admin))
            .then_with(|| {
                let an = if a.display_name.is_empty() { &a.username } else { &a.display_name };
                let bn = if b.display_name.is_empty() { &b.username } else { &b.display_name };
                an.to_lowercase().cmp(&bn.to_lowercase())
            })
    });
    Ok(users)
}

// Membership list of the local Administrators group. Names only (Level=1
// gives PSID too but we match by name anyway — cheaper). Uses the
// well-known SID S-1-5-32-544 indirectly via the localised group name:
// on a non-English Windows "Administrators" is translated, so we look up
// the name from the SID first.
fn local_admin_names() -> Result<HashSet<String>> {
    unsafe {
        let group_name = admin_group_name()?;
        let group_wide: Vec<u16> = group_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let mut buf_ptr: *mut u8 = std::ptr::null_mut();
        let mut entries_read: u32 = 0;
        let mut total_entries: u32 = 0;
        let mut resume: usize = 0;
        let rc = NetLocalGroupGetMembers(
            None,
            windows::core::PCWSTR(group_wide.as_ptr()),
            1,
            &mut buf_ptr,
            u32::MAX,
            &mut entries_read,
            &mut total_entries,
            Some(&mut resume),
        );
        if rc != 0 {
            bail!("NetLocalGroupGetMembers failed with code {rc}");
        }
        let _guard = BufferGuard(buf_ptr as *const _);
        let slice =
            std::slice::from_raw_parts(buf_ptr as *const LOCALGROUP_MEMBERS_INFO_1, entries_read as usize);

        let mut out = HashSet::new();
        for e in slice {
            let name = pwstr_to_string(e.lgrmi1_name);
            // Members may come back as "MACHINE\user" or just "user"; the
            // local admin comparison only needs the trailing segment.
            let short = name.rsplit_once('\\').map(|(_, r)| r.to_string()).unwrap_or(name);
            out.insert(short);
        }
        Ok(out)
    }
}

// Localised name of the built-in Administrators group (S-1-5-32-544).
fn admin_group_name() -> Result<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Security::{
        CreateWellKnownSid, LookupAccountSidW, WinBuiltinAdministratorsSid, PSID, SID_NAME_USE,
    };

    unsafe {
        let mut sid_buf = [0u8; 68];
        let mut sid_size: u32 = sid_buf.len() as u32;
        let sid = PSID(sid_buf.as_mut_ptr() as *mut _);
        CreateWellKnownSid(WinBuiltinAdministratorsSid, None, Some(sid), &mut sid_size)
            .context("CreateWellKnownSid(BuiltinAdmins)")?;

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
            bail!("LookupAccountSidW: zero name length for Administrators SID");
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
        .context("LookupAccountSidW(BuiltinAdmins)")?;
        Ok(String::from_utf16_lossy(&name[..name_len as usize]))
    }
}

fn pwstr_to_string(p: PWSTR) -> String {
    if p.0.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0usize;
        while *p.0.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p.0, len))
    }
}

struct BufferGuard(*const core::ffi::c_void);
impl Drop for BufferGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = NetApiBufferFree(Some(self.0));
            }
        }
    }
}
