// Win32 fallback lock primitives. Not the primary path — the overlay is —
// but useful for:
//   - terminating a process whose limit is exceeded (perAppLimits)
//   - forcing Windows to lock as a belt-and-suspenders option

#![cfg(windows)]

use anyhow::Result;
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        Shutdown::LockWorkStation,
        Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE},
    },
};

pub fn lock_workstation() -> Result<()> {
    unsafe { LockWorkStation()? };
    Ok(())
}

pub fn terminate_process(pid: u32) -> Result<()> {
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_TERMINATE, false, pid)?;
        let res = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
        res?;
    }
    Ok(())
}
