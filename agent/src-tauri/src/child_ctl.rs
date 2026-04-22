// Cross-user child-DB manipulation for the parent's AdminSetup window.
//
// Why exists: v0.1.12 isolates each Windows child account's data in its own
// sqlite file at %ProgramData%\TickTock\users\{username}\ticktock.sqlite.
// The parent's admin session never loads its own AppState (admin is
// unrestricted); instead AdminSetup opens each child's DB here to read
// status + write commands (issue one-time PIN, adjust schedule, grant bonus,
// reset usage, …).
//
// Concurrency: SQLite in WAL mode handles the "child's own agent has the
// DB open, parent is writing" case gracefully (the parent's session is
// never active at the same time as any child's anyway — single console
// user — but the rusqlite Connection is short-lived per call so locks
// are minimal). If the child's agent isn't running (offline / disconnected
// session) the writes land immediately and the child picks them up on the
// next bootstrap.
//
// What this is NOT: a live command channel. Lock/unlock commands don't do
// anything useful while the child is offline (overlay is already showing
// from fail-closed boot), and if the child is on console the parent can't
// be in AdminSetup. Live commands still go through Firebase RTDB for the
// mobile-parent-off-premises flow.

#![cfg(windows)]

use anyhow::{bail, Context, Result};
use chrono::{Duration as ChronoDuration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

fn open_child_db(username: &str) -> Result<Connection> {
    let path = crate::config::user_db_path(username)?;
    if !path.exists() {
        bail!(
            "자녀 '{username}' 는 아직 첫 로그인을 하지 않아 데이터가 없습니다"
        );
    }
    let c = Connection::open(&path).context("open child DB")?;
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.busy_timeout(std::time::Duration::from_millis(2000))?;
    Ok(c)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChildStatus {
    pub username: String,
    pub display_name: String,
    /// true if the child has ever logged in (DB file exists).
    pub has_db: bool,
    pub paired: bool,
    pub device_id: Option<String>,
    pub has_pin: bool,
    pub today_used_minutes: u32,
    pub daily_limit_minutes: u32,
    /// Raw schedule JSON — UI parses for allowed_ranges editor.
    pub schedule_json: Option<String>,
    pub has_temp_pin: bool,
    pub temp_pin_minutes: Option<u32>,
    /// Session in progress (unlocked until this UTC ms epoch).
    pub session_expires_at_ms: Option<i64>,
    /// Session paused, this many seconds remain if resumed.
    pub session_paused_seconds: Option<i64>,
}

pub fn status_for(username: &str, display_name: &str) -> Result<ChildStatus> {
    let path = crate::config::user_db_path(username)?;
    if !path.exists() {
        return Ok(ChildStatus {
            username: username.to_string(),
            display_name: display_name.to_string(),
            has_db: false,
            paired: false,
            device_id: None,
            has_pin: false,
            today_used_minutes: 0,
            daily_limit_minutes: 0,
            schedule_json: None,
            has_temp_pin: false,
            temp_pin_minutes: None,
            session_expires_at_ms: None,
            session_paused_seconds: None,
        });
    }
    let conn = open_child_db(username)?;

    let device_id: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key = 'device_id'", [], |r| r.get(0))
        .optional()?;
    let has_pin = conn
        .query_row("SELECT 1 FROM kv WHERE key = 'pin_hash'", [], |r| r.get::<_, i64>(0))
        .optional()?
        .is_some();
    let schedule_json: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key = 'schedule'", [], |r| r.get(0))
        .optional()?;

    let daily_limit_minutes = schedule_json
        .as_ref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| {
            v.get("daily_limit_minutes")
                .and_then(|n| n.as_u64())
                .map(|n| n as u32)
        })
        .unwrap_or(0);

    // Today usage — sum across all processes.
    let today = Utc::now().date_naive().format("%Y-%m-%d").to_string();
    let today_seconds: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(active_seconds), 0) FROM daily_summary WHERE date = ?1",
            [&today],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let today_used_minutes = (today_seconds / 60) as u32;

    let temp_pin_hash: Option<String> = conn
        .query_row(
            "SELECT value FROM kv WHERE key = 'temp_pin_hash'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let temp_pin_minutes: Option<u32> = conn
        .query_row(
            "SELECT value FROM kv WHERE key = 'temp_pin_minutes'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|s| s.parse::<u32>().ok());

    let session_expires_at_ms: Option<i64> = conn
        .query_row(
            "SELECT value FROM kv WHERE key = 'session_expires_at_ms'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|s| s.parse::<i64>().ok());
    let session_paused_seconds: Option<i64> = conn
        .query_row(
            "SELECT value FROM kv WHERE key = 'session_paused_seconds'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|s| s.parse::<i64>().ok());

    Ok(ChildStatus {
        username: username.to_string(),
        display_name: display_name.to_string(),
        has_db: true,
        paired: device_id.is_some(),
        device_id,
        has_pin,
        today_used_minutes,
        daily_limit_minutes,
        schedule_json,
        has_temp_pin: temp_pin_hash.is_some(),
        temp_pin_minutes,
        session_expires_at_ms,
        session_paused_seconds,
    })
}

pub fn issue_temp_pin(username: &str, pin: &str, minutes: u32) -> Result<()> {
    if minutes == 0 {
        bail!("분(minutes)은 1 이상이어야 합니다");
    }
    if pin.len() < 4 || pin.len() > 6 || !pin.chars().all(|c| c.is_ascii_digit()) {
        bail!("PIN 은 4~6자리 숫자여야 합니다");
    }
    let hash = crate::lock::pin::hash(pin)?;
    let conn = open_child_db(username)?;
    // New PIN invalidates any running / paused session from the previous PIN.
    conn.execute(
        "DELETE FROM kv WHERE key IN ('session_expires_at_ms', 'session_paused_seconds')",
        [],
    )?;
    upsert_kv(&conn, "temp_pin_hash", &hash)?;
    upsert_kv(&conn, "temp_pin_minutes", &minutes.to_string())?;
    Ok(())
}

pub fn revoke_temp_pin(username: &str) -> Result<()> {
    let conn = open_child_db(username)?;
    conn.execute(
        "DELETE FROM kv WHERE key IN ('temp_pin_hash', 'temp_pin_minutes', 'session_expires_at_ms', 'session_paused_seconds')",
        [],
    )?;
    Ok(())
}

pub fn adjust_temp_pin_minutes(username: &str, minutes: u32) -> Result<()> {
    if minutes == 0 {
        bail!("분(minutes)은 1 이상이어야 합니다");
    }
    let conn = open_child_db(username)?;
    let has_pin: bool = conn
        .query_row("SELECT 1 FROM kv WHERE key = 'temp_pin_hash'", [], |r| r.get::<_, i64>(0))
        .optional()?
        .is_some();
    if !has_pin {
        bail!("발급된 1회성 PIN 이 없습니다");
    }
    upsert_kv(&conn, "temp_pin_minutes", &minutes.to_string())?;
    // Adjust the running session expiry if one exists — parent's intent is
    // "the child has this many minutes *from now*".
    let running: Option<i64> = conn
        .query_row(
            "SELECT value FROM kv WHERE key = 'session_expires_at_ms'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|s| s.parse::<i64>().ok());
    if running.is_some() {
        let new_expiry = (Utc::now() + ChronoDuration::minutes(minutes as i64))
            .timestamp_millis()
            .to_string();
        upsert_kv(&conn, "session_expires_at_ms", &new_expiry)?;
    } else {
        // If paused (not running), reset paused remainder.
        let paused: Option<i64> = conn
            .query_row(
                "SELECT value FROM kv WHERE key = 'session_paused_seconds'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|s| s.parse::<i64>().ok());
        if paused.is_some() {
            upsert_kv(
                &conn,
                "session_paused_seconds",
                &(minutes as i64 * 60).to_string(),
            )?;
        }
    }
    Ok(())
}

pub fn set_schedule(username: &str, schedule_json: &str) -> Result<()> {
    // Validate JSON structure minimally before writing.
    let v: serde_json::Value =
        serde_json::from_str(schedule_json).context("schedule JSON 파싱 실패")?;
    if !v.is_object() {
        bail!("schedule 은 object 여야 합니다");
    }
    let conn = open_child_db(username)?;
    upsert_kv(&conn, "schedule", schedule_json)?;
    Ok(())
}

pub fn grant_bonus_minutes(username: &str, minutes: u32) -> Result<()> {
    let conn = open_child_db(username)?;
    let current: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key = 'schedule'", [], |r| r.get(0))
        .optional()?;
    let mut schedule: serde_json::Value = match current {
        Some(j) => serde_json::from_str(&j).unwrap_or_else(|_| default_schedule()),
        None => default_schedule(),
    };
    let cur = schedule
        .get("daily_limit_minutes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    schedule["daily_limit_minutes"] = serde_json::json!(cur.saturating_add(minutes));
    let new_json = serde_json::to_string(&schedule)?;
    upsert_kv(&conn, "schedule", &new_json)?;
    Ok(())
}

pub fn reset_today_usage(username: &str) -> Result<()> {
    let conn = open_child_db(username)?;
    let today = Utc::now().date_naive().format("%Y-%m-%d").to_string();
    conn.execute("DELETE FROM daily_summary WHERE date = ?1", params![today])?;
    Ok(())
}

pub fn clear_main_pin(username: &str) -> Result<()> {
    let conn = open_child_db(username)?;
    conn.execute("DELETE FROM kv WHERE key = 'pin_hash'", [])?;
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    pub date: String,
    pub minutes: u32,
}

pub fn usage_history(username: &str, days: u32) -> Result<Vec<UsageDay>> {
    let conn = open_child_db(username)?;
    let cutoff = (Utc::now() - ChronoDuration::days(days as i64))
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let mut stmt = conn.prepare(
        "SELECT date, SUM(active_seconds) FROM daily_summary \
         WHERE date >= ?1 GROUP BY date ORDER BY date DESC",
    )?;
    let rows = stmt
        .query_map([cutoff], |r| {
            let date: String = r.get(0)?;
            let seconds: i64 = r.get(1)?;
            Ok(UsageDay {
                date,
                minutes: (seconds / 60) as u32,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn upsert_kv(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO kv (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn default_schedule() -> serde_json::Value {
    serde_json::json!({
        "allowed_ranges": [],
        "daily_limit_minutes": 0,
        "per_app_limits": {},
    })
}
