// Machine-wide agent config stored in %ProgramData%\TickTock\config.json.
//
// Why ProgramData (not per-user AppData):
//   The Windows Service (LocalSystem) and the user-session child (standard
//   user) must see the *same* config — specifically `allowed_users`, the list
//   of Windows accounts that should receive an overlay. Per-user AppData would
//   give each account its own silo and make the spawner's "is this session
//   allowed?" check unanswerable from the service side.
//
// ACL: the directory is created by the service (LocalSystem) on startup and
// granted "Modify" to the local Users group so that standard-user children
// can read + write the sqlite DB that lives alongside the config. The config
// file itself is small JSON; we write it atomically (tmp + rename).
//
// Debug builds keep everything under %USERPROFILE%\.ticktock-dev\ as before —
// no ProgramData, no ACL changes, no service involvement.
//
// PR1 scope: only `allowed_users` is read. `admin_user` is reserved for PR2
// (admin setup UI) and PR3 (remote reconfiguration).
//
// `allowed_users` semantics:
//   - Non-empty: spawner only launches a child in a session whose Windows
//     username is on the list. Parent / other sessions get no overlay.
//   - Empty (fresh install, before first PIN setup): spawner allows any
//     session so the first-run UI can appear. `setup_pin_and_unlock` then
//     records the current user, and the guard takes effect from then on.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

const CONFIG_FILENAME: &str = "config.json";
const DB_FILENAME: &str = "ticktock.sqlite";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentConfig {
    #[serde(default)]
    pub allowed_users: Vec<String>,
    #[serde(default)]
    pub admin_user: Option<String>,
}

pub fn programdata_dir() -> Result<PathBuf> {
    if cfg!(debug_assertions) {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .context("no home directory (USERPROFILE/HOME)")?;
        return Ok(PathBuf::from(home).join(".ticktock-dev"));
    }
    let pd = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    Ok(pd.join("TickTock"))
}

pub fn config_path() -> Result<PathBuf> {
    Ok(programdata_dir()?.join(CONFIG_FILENAME))
}

pub fn db_path() -> Result<PathBuf> {
    Ok(programdata_dir()?.join(DB_FILENAME))
}

pub fn load() -> Result<AgentConfig> {
    let path = config_path()?;
    match fs::read_to_string(&path) {
        Ok(text) => {
            let cfg: AgentConfig = serde_json::from_str(&text)
                .with_context(|| format!("parse {}", path.display()))?;
            Ok(cfg)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AgentConfig::default()),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

pub fn save(cfg: &AgentConfig) -> Result<()> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string_pretty(cfg)?;
    // Atomic-ish write: write to a sibling tmp then rename over the target.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

pub fn add_allowed_user(username: &str) -> Result<()> {
    let mut cfg = load()?;
    if !cfg
        .allowed_users
        .iter()
        .any(|u| u.eq_ignore_ascii_case(username))
    {
        cfg.allowed_users.push(username.to_string());
        save(&cfg)?;
    }
    Ok(())
}

pub fn is_allowed(username: &str) -> bool {
    let cfg = match load() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("config load failed, treating all sessions as allowed: {e:#}");
            return true;
        }
    };
    // Empty list → fresh install, allow so first-run PIN setup can appear.
    if cfg.allowed_users.is_empty() {
        return true;
    }
    cfg.allowed_users
        .iter()
        .any(|u| u.eq_ignore_ascii_case(username))
}

/// Create %ProgramData%\TickTock\ and grant the local Users group Modify
/// rights (so standard-user child processes can read + write the sqlite DB).
///
/// Meant to be called from the Windows Service at startup, where we run as
/// LocalSystem and have the privileges to both mkdir under ProgramData and
/// edit the DACL. Failures are logged but non-fatal — the agent may still
/// work if a previous install already set up the ACL.
#[cfg(windows)]
pub fn ensure_dir_with_acl() -> Result<()> {
    let dir = programdata_dir()?;
    fs::create_dir_all(&dir).with_context(|| format!("create_dir_all {}", dir.display()))?;
    grant_users_modify(&dir)?;
    Ok(())
}

#[cfg(not(windows))]
pub fn ensure_dir_with_acl() -> Result<()> {
    let dir = programdata_dir()?;
    fs::create_dir_all(&dir).ok();
    Ok(())
}

#[cfg(windows)]
fn grant_users_modify(dir: &Path) -> Result<()> {
    // icacls is simpler and more reliable here than hand-rolling
    // SetNamedSecurityInfoW with SIDs. This runs once at service startup.
    //   (OI) = object inherit, (CI) = container inherit, M = modify.
    let output = std::process::Command::new("icacls")
        .arg(dir)
        .arg("/grant")
        .arg("*S-1-5-32-545:(OI)(CI)M") // Well-known SID for local "Users" group
        .arg("/T")
        .output()
        .with_context(|| "invoke icacls")?;
    if !output.status.success() {
        log::warn!(
            "icacls on {} failed: {}",
            dir.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}
