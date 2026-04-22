// Local SQLite storage + in-memory AppState shared across async tasks.
//
// Tables:
//   sessions(id, process_name, exe_path, window_title, started_at, ended_at, active_seconds)
//   daily_summary(date, process_name, active_seconds)        -- aggregate cache
//   kv(key, value)                                           -- device_id, pin_hash, refresh_token, schedule_json
//   pin_attempts(ts, success)                                -- rate limiting
//
// AppState wraps an Arc<Inner> with a RwLock<Mutable> for hot state and a
// Mutex<Connection> for DB access. SQLite calls happen inside spawn_blocking
// to avoid stalling the tokio runtime.

use anyhow::{Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, Utc};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{Notify, RwLock};

use crate::{
    schedule::{LockReason, Schedule},
    usage::ForegroundInfo,
};

const MIGRATION_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    process_name    TEXT NOT NULL,
    exe_path        TEXT NOT NULL,
    window_title    TEXT NOT NULL,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER NOT NULL,
    active_seconds  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

CREATE TABLE IF NOT EXISTS daily_summary (
    date            TEXT NOT NULL,
    process_name    TEXT NOT NULL,
    active_seconds  INTEGER NOT NULL,
    PRIMARY KEY (date, process_name)
);

CREATE TABLE IF NOT EXISTS kv (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pin_attempts (
    ts              INTEGER NOT NULL,
    success         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pin_attempts_ts ON pin_attempts(ts);
"#;

const KV_SESSION_EXPIRES_MS: &str = "session_expires_at_ms";
const KV_SESSION_PAUSED_SECS: &str = "session_paused_seconds";

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

struct Inner {
    mutable: RwLock<Mutable>,
    db: Mutex<Connection>,
    // Notified whenever lock state changes so the Firebase pusher can react
    // immediately rather than waiting for the 30s heartbeat.
    state_changed: Notify,
}

struct Mutable {
    schedule: Schedule,
    timezone: Tz,
    locked: bool,
    lock_reason: LockReason,
    open_session: Option<OpenSession>,
    today_used_seconds: i64,
    today_date: NaiveDate,
    dirty_usage: HashMap<String, i64>, // processName -> unsynced seconds for today
    // One-time-PIN session: when Some, the overlay is unlocked until this moment,
    // after which the schedule ticker relocks and clears this field.
    session_expires_at: Option<DateTime<Utc>>,
    // When the parent locks during an active one-time-PIN session we park the
    // remaining seconds here instead of discarding them. A later unlock turns
    // this back into session_expires_at = now + paused.
    session_paused_seconds: Option<i64>,
}

#[derive(Clone, Debug)]
struct OpenSession {
    info: ForegroundInfo,
    started_at: DateTime<Utc>,
    last_tick: DateTime<Utc>,
    active_seconds: i64,
    // Seconds of `active_seconds` that have already been written to
    // daily_summary by the periodic flusher. persist_session only needs to
    // write the remaining tail, and a restart at most loses one flush interval.
    flushed_seconds: i64,
}

impl AppState {
    pub async fn load_for_user(username: &str) -> Result<Self> {
        let db_path = crate::config::user_db_path(username)?;

        // One-shot migration: v0.1.8 and earlier wrote a single
        // machine-wide DB. If this is the first v0.1.9 boot AND this
        // user looks like the original single child (the only name in
        // allowed_users, or allowed_users still empty), adopt the legacy
        // DB so pairing / PIN / schedule survive the upgrade.
        migrate_legacy_db_if_applicable(username, &db_path);

        log::info!("sqlite (user={}): {}", username, db_path.display());

        let conn = tokio::task::spawn_blocking(move || -> Result<Connection> {
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let c = Connection::open(&db_path).context("open sqlite")?;
            c.execute_batch(MIGRATION_SQL)?;
            c.pragma_update(None, "journal_mode", "WAL")?;
            Ok(c)
        })
        .await??;

        // Load persisted schedule and timezone from kv.
        let (schedule, timezone) = load_initial_state(&conn)?;

        let today = today_local(&timezone);
        let today_used_seconds = load_daily_total(&conn, &today.format("%Y-%m-%d").to_string())?;

        let (session_expires_at, session_paused_seconds) = load_session_state(&conn)?;

        let mutable = Mutable {
            schedule,
            timezone,
            locked: true,
            lock_reason: LockReason::Boot,
            open_session: None,
            today_used_seconds,
            today_date: today,
            dirty_usage: HashMap::new(),
            session_expires_at,
            session_paused_seconds,
        };

        Ok(Self(Arc::new(Inner {
            mutable: RwLock::new(mutable),
            db: Mutex::new(conn),
            state_changed: Notify::new(),
        })))
    }

    /// Wakes once per observed state change. Use in a loop from the pusher task.
    pub async fn wait_state_changed(&self) {
        self.0.state_changed.notified().await
    }

    // --- Read accessors ---

    pub async fn current_schedule(&self) -> Schedule {
        self.0.mutable.read().await.schedule.clone()
    }

    pub async fn timezone(&self) -> Tz {
        self.0.mutable.read().await.timezone
    }

    pub async fn is_locked(&self) -> bool {
        self.0.mutable.read().await.locked
    }

    pub async fn lock_reason(&self) -> LockReason {
        self.0.mutable.read().await.lock_reason.clone()
    }

    pub async fn today_used_minutes(&self) -> u32 {
        (self.0.mutable.read().await.today_used_seconds / 60) as u32
    }

    pub async fn session_expires_at(&self) -> Option<DateTime<Utc>> {
        self.0.mutable.read().await.session_expires_at
    }

    pub async fn session_paused_seconds(&self) -> Option<i64> {
        self.0.mutable.read().await.session_paused_seconds
    }

    pub async fn set_session_expires_at(&self, at: Option<DateTime<Utc>>) {
        {
            let mut w = self.0.mutable.write().await;
            w.session_expires_at = at;
            // Starting a fresh session clears any leftover paused remainder.
            if at.is_some() {
                w.session_paused_seconds = None;
            }
        }
        self.persist_session_state().await;
        self.0.state_changed.notify_one();
    }

    pub async fn session_remaining_seconds(&self) -> Option<i64> {
        let at = self.0.mutable.read().await.session_expires_at?;
        let remaining = (at - Utc::now()).num_seconds();
        if remaining <= 0 { None } else { Some(remaining) }
    }

    /// Converts a running session to a paused snapshot so the remaining time
    /// survives a parent lock. Returns the paused seconds if there was one.
    pub async fn pause_session(&self) -> Option<i64> {
        let result = {
            let mut w = self.0.mutable.write().await;
            match w.session_expires_at.take() {
                Some(at) => {
                    let remaining = (at - Utc::now()).num_seconds();
                    if remaining <= 0 {
                        w.session_paused_seconds = None;
                        None
                    } else {
                        w.session_paused_seconds = Some(remaining);
                        Some(remaining)
                    }
                }
                None => None,
            }
        };
        self.persist_session_state().await;
        self.0.state_changed.notify_one();
        result
    }

    /// Resumes a paused session: turns paused_seconds back into an
    /// expires_at = now + paused. Returns the new expiry if resumed.
    pub async fn resume_session(&self) -> Option<DateTime<Utc>> {
        let result = {
            let mut w = self.0.mutable.write().await;
            match w.session_paused_seconds.take() {
                Some(secs) => {
                    let expires_at = Utc::now() + ChronoDuration::seconds(secs);
                    w.session_expires_at = Some(expires_at);
                    Some(expires_at)
                }
                None => None,
            }
        };
        self.persist_session_state().await;
        self.0.state_changed.notify_one();
        result
    }

    /// Re-aim the one-time-PIN window to `minutes` total. If a session is
    /// running it becomes `now + minutes`; if paused the paused remainder is
    /// set to `minutes * 60`. With no session, only the stored PIN's minutes
    /// are updated so the next use starts with the new amount.
    pub async fn adjust_session_minutes(&self, minutes: u32) -> Result<()> {
        let secs = (minutes as i64).saturating_mul(60);
        {
            let mut w = self.0.mutable.write().await;
            if w.session_expires_at.is_some() {
                w.session_expires_at = Some(Utc::now() + ChronoDuration::seconds(secs));
                w.session_paused_seconds = None;
            } else if w.session_paused_seconds.is_some() {
                w.session_paused_seconds = Some(secs);
            }
        }
        self.persist_session_state().await;
        // Also update the stored PIN's minutes so future first-use matches.
        if self.kv_get("temp_pin_hash").await?.is_some() {
            self.kv_set("temp_pin_minutes", &minutes.to_string()).await?;
        }
        self.0.state_changed.notify_one();
        Ok(())
    }

    /// Fully clear both running and paused session state.
    pub async fn clear_session(&self) {
        {
            let mut w = self.0.mutable.write().await;
            w.session_expires_at = None;
            w.session_paused_seconds = None;
        }
        self.persist_session_state().await;
        self.0.state_changed.notify_one();
    }

    // --- One-time PIN (temporary) ---
    // Stored in kv as { temp_pin_hash, temp_pin_minutes }. A single slot — issuing
    // a new one overwrites the previous. Cleared when consumed by verify_pin_and_unlock.

    pub async fn set_temp_pin(&self, hash: &str, minutes: u32) -> Result<()> {
        self.kv_set("temp_pin_hash", hash).await?;
        self.kv_set("temp_pin_minutes", &minutes.to_string()).await?;
        Ok(())
    }

    pub async fn get_temp_pin(&self) -> Result<Option<(String, u32)>> {
        let Some(hash) = self.kv_get("temp_pin_hash").await? else { return Ok(None) };
        let minutes: u32 = self
            .kv_get("temp_pin_minutes")
            .await?
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        Ok(Some((hash, minutes)))
    }

    pub async fn clear_temp_pin(&self) -> Result<()> {
        let db = self.0.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = db.db.lock().unwrap();
            conn.execute("DELETE FROM kv WHERE key IN ('temp_pin_hash', 'temp_pin_minutes')", [])?;
            Ok(())
        })
        .await?
    }

    pub async fn foreground_process_name(&self) -> Option<String> {
        self.0.mutable.read().await.open_session.as_ref().map(|s| s.info.process_name.clone())
    }

    // --- Mutators ---

    pub async fn set_locked(&self, locked: bool, reason: LockReason) {
        let mut w = self.0.mutable.write().await;
        w.locked = locked;
        w.lock_reason = reason;
        drop(w);
        self.0.state_changed.notify_one();
    }

    pub async fn set_schedule(&self, schedule: Schedule) -> Result<()> {
        let json = serde_json::to_string(&schedule)?;
        self.kv_set("schedule", &json).await?;
        self.0.mutable.write().await.schedule = schedule;
        Ok(())
    }

    pub async fn grant_bonus_minutes(&self, minutes: u32) -> Result<()> {
        let mut w = self.0.mutable.write().await;
        w.schedule.daily_limit_minutes = w.schedule.daily_limit_minutes.saturating_add(minutes);
        let json = serde_json::to_string(&w.schedule)?;
        drop(w);
        self.kv_set("schedule", &json).await?;
        Ok(())
    }

    // --- Session / usage tracking ---

    pub async fn extend_or_open_session(&self, info: ForegroundInfo) -> Result<()> {
        let now = Utc::now();
        let mut w = self.0.mutable.write().await;

        // Day rollover: close any open session and reset today's counters.
        let today = today_local(&w.timezone);
        if today != w.today_date {
            if let Some(open) = w.open_session.take() {
                self.persist_session(open).await?;
            }
            w.today_date = today;
            w.today_used_seconds = 0;
            w.dirty_usage.clear();
        }

        let tick_seconds = match &w.open_session {
            Some(s) => (now - s.last_tick).num_seconds().max(0).min(5),
            None => 0,
        };

        match &mut w.open_session {
            Some(s) if s.info.process_name == info.process_name => {
                s.active_seconds += tick_seconds;
                s.last_tick = now;
                if tick_seconds > 0 {
                    w.today_used_seconds += tick_seconds;
                    *w.dirty_usage.entry(info.process_name.clone()).or_default() += tick_seconds;
                }
            }
            _ => {
                if let Some(prev) = w.open_session.take() {
                    drop(w);
                    self.persist_session(prev).await?;
                    w = self.0.mutable.write().await;
                }
                w.open_session = Some(OpenSession {
                    info,
                    started_at: now,
                    last_tick: now,
                    active_seconds: 0,
                    flushed_seconds: 0,
                });
            }
        }
        Ok(())
    }

    pub async fn close_open_session(&self) -> Result<()> {
        let mut w = self.0.mutable.write().await;
        if let Some(open) = w.open_session.take() {
            drop(w);
            self.persist_session(open).await?;
        }
        Ok(())
    }

    async fn persist_session(&self, open: OpenSession) -> Result<()> {
        if open.active_seconds == 0 {
            return Ok(());
        }
        let tz = self.timezone().await;
        let date_str = open.started_at.with_timezone(&tz).format("%Y-%m-%d").to_string();
        // Periodic flushes may have already recorded part of this session;
        // only write the tail to daily_summary to avoid double-counting.
        let tail_seconds = (open.active_seconds - open.flushed_seconds).max(0);
        let db = self.0.clone();

        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = db.db.lock().unwrap();
            conn.execute(
                "INSERT INTO sessions (process_name, exe_path, window_title, started_at, ended_at, active_seconds)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    open.info.process_name,
                    open.info.exe_path,
                    open.info.window_title,
                    open.started_at.timestamp(),
                    open.last_tick.timestamp(),
                    open.active_seconds,
                ],
            )?;
            if tail_seconds > 0 {
                conn.execute(
                    "INSERT INTO daily_summary (date, process_name, active_seconds) VALUES (?1, ?2, ?3)
                     ON CONFLICT(date, process_name) DO UPDATE SET active_seconds = active_seconds + excluded.active_seconds",
                    params![date_str, open.info.process_name, tail_seconds],
                )?;
            }
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// Periodically write the not-yet-flushed portion of the currently open
    /// session to daily_summary. Called from the usage poller; a crash/restart
    /// loses at most `FLUSH_INTERVAL_SECS` worth of active time instead of the
    /// entire in-progress session.
    pub async fn flush_open_session_if_due(&self) -> Result<()> {
        const FLUSH_INTERVAL_SECS: i64 = 60;

        let (process_name, date_str, delta) = {
            let mut w = self.0.mutable.write().await;
            // Read timezone before the mutable borrow of open_session below.
            let tz = w.timezone;
            let Some(open) = w.open_session.as_mut() else { return Ok(()) };
            let delta = open.active_seconds - open.flushed_seconds;
            if delta < FLUSH_INTERVAL_SECS {
                return Ok(());
            }
            let date_str = open.started_at.with_timezone(&tz).format("%Y-%m-%d").to_string();
            let process_name = open.info.process_name.clone();
            open.flushed_seconds = open.active_seconds;
            (process_name, date_str, delta)
        };

        let db = self.0.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = db.db.lock().unwrap();
            conn.execute(
                "INSERT INTO daily_summary (date, process_name, active_seconds) VALUES (?1, ?2, ?3)
                 ON CONFLICT(date, process_name) DO UPDATE SET active_seconds = active_seconds + excluded.active_seconds",
                params![date_str, process_name, delta],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// Nuke everything local: kv, daily_summary, sessions, pin_attempts, and
    /// in-memory counters / schedule / session state. Used for "unregister
    /// this PC" from the parent app — next boot is indistinguishable from a
    /// fresh install, so the agent goes back into pairing mode.
    pub async fn wipe_all(&self) -> Result<()> {
        let db = self.0.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = db.db.lock().unwrap();
            conn.execute("DELETE FROM sessions", [])?;
            conn.execute("DELETE FROM daily_summary", [])?;
            conn.execute("DELETE FROM kv", [])?;
            conn.execute("DELETE FROM pin_attempts", [])?;
            Ok(())
        })
        .await??;

        let mut w = self.0.mutable.write().await;
        w.session_expires_at = None;
        w.session_paused_seconds = None;
        w.today_used_seconds = 0;
        w.open_session = None;
        w.dirty_usage.clear();
        w.schedule = default_schedule();
        w.locked = true;
        w.lock_reason = LockReason::Boot;
        drop(w);
        self.0.state_changed.notify_one();
        Ok(())
    }

    /// Wipe today's accumulated usage (seconds, open session, daily_summary
    /// rows for today). Used when the parent explicitly resets from the app.
    /// The sessions table is kept as an audit log.
    pub async fn reset_today_usage(&self) -> Result<NaiveDate> {
        let mut w = self.0.mutable.write().await;
        let today = w.today_date;
        let date_str = today.format("%Y-%m-%d").to_string();
        w.today_used_seconds = 0;
        w.open_session = None;
        w.dirty_usage.clear();
        drop(w);

        let db = self.0.clone();
        let date_for_db = date_str.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = db.db.lock().unwrap();
            conn.execute("DELETE FROM daily_summary WHERE date = ?1", [&date_for_db])?;
            Ok(())
        })
        .await??;

        self.0.state_changed.notify_one();
        Ok(today)
    }

    /// Return dirty per-process seconds accumulated today (since last sync), and clear.
    pub async fn drain_dirty_usage(&self) -> (NaiveDate, HashMap<String, i64>) {
        let mut w = self.0.mutable.write().await;
        let date = w.today_date;
        let drained = std::mem::take(&mut w.dirty_usage);
        (date, drained)
    }

    /// All per-process seconds accumulated on a given date.
    pub async fn daily_summary(&self, date_ymd: &str) -> Result<Vec<(String, i64)>> {
        let db = self.0.clone();
        let date = date_ymd.to_string();
        tokio::task::spawn_blocking(move || -> Result<Vec<(String, i64)>> {
            let conn = db.db.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT process_name, active_seconds FROM daily_summary WHERE date = ?1",
            )?;
            let rows = stmt
                .query_map([date], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?
    }

    // --- Key/value ---

    pub async fn kv_get(&self, key: &str) -> Result<Option<String>> {
        let db = self.0.clone();
        let key = key.to_string();
        tokio::task::spawn_blocking(move || -> Result<Option<String>> {
            let conn = db.db.lock().unwrap();
            Ok(conn
                .query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get::<_, String>(0))
                .optional()?)
        })
        .await?
    }

    pub async fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        let db = self.0.clone();
        let key = key.to_string();
        let value = value.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = db.db.lock().unwrap();
            conn.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
        .await?
    }

    pub async fn kv_delete(&self, key: &str) -> Result<()> {
        let db = self.0.clone();
        let key = key.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = db.db.lock().unwrap();
            conn.execute("DELETE FROM kv WHERE key = ?1", [key])?;
            Ok(())
        })
        .await?
    }

    /// Mirror the current in-memory session state to kv so a restart can
    /// resume the running / paused one-time-PIN session.
    async fn persist_session_state(&self) {
        let (expires, paused) = {
            let r = self.0.mutable.read().await;
            (r.session_expires_at, r.session_paused_seconds)
        };
        match expires {
            Some(at) => {
                let _ = self.kv_set(KV_SESSION_EXPIRES_MS, &at.timestamp_millis().to_string()).await;
            }
            None => { let _ = self.kv_delete(KV_SESSION_EXPIRES_MS).await; }
        }
        match paused {
            Some(s) => { let _ = self.kv_set(KV_SESSION_PAUSED_SECS, &s.to_string()).await; }
            None => { let _ = self.kv_delete(KV_SESSION_PAUSED_SECS).await; }
        }
    }

    // --- PIN rate limiting ---

    pub async fn record_pin_attempt(&self, success: bool) -> Result<()> {
        let db = self.0.clone();
        let now = Utc::now().timestamp();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = db.db.lock().unwrap();
            conn.execute("INSERT INTO pin_attempts (ts, success) VALUES (?1, ?2)", params![now, success as i64])?;
            Ok(())
        })
        .await?
    }

    /// True if the user is currently locked out from PIN attempts (5 fails in 10 min).
    pub async fn pin_locked_out(&self) -> Result<bool> {
        let db = self.0.clone();
        let since = (Utc::now() - ChronoDuration::minutes(10)).timestamp();
        tokio::task::spawn_blocking(move || -> Result<bool> {
            let conn = db.db.lock().unwrap();
            let fails: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pin_attempts WHERE ts > ?1 AND success = 0",
                [since],
                |r| r.get(0),
            )?;
            Ok(fails >= 5)
        })
        .await?
    }
}


fn load_initial_state(conn: &Connection) -> Result<(Schedule, Tz)> {
    let schedule_json: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key = 'schedule'", [], |r| r.get(0))
        .optional()?;
    let schedule = match schedule_json {
        Some(s) => serde_json::from_str(&s).unwrap_or_else(|_| default_schedule()),
        None => default_schedule(),
    };

    let tz_str: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key = 'timezone'", [], |r| r.get(0))
        .optional()?;
    let timezone: Tz = tz_str.and_then(|s| s.parse().ok()).unwrap_or(chrono_tz::Asia::Seoul);

    Ok((schedule, timezone))
}

fn load_session_state(conn: &Connection) -> Result<(Option<DateTime<Utc>>, Option<i64>)> {
    let expires_at = conn
        .query_row(
            "SELECT value FROM kv WHERE key = ?1",
            [KV_SESSION_EXPIRES_MS],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|s| s.parse::<i64>().ok())
        .and_then(DateTime::<Utc>::from_timestamp_millis);
    let paused = conn
        .query_row(
            "SELECT value FROM kv WHERE key = ?1",
            [KV_SESSION_PAUSED_SECS],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|s| s.parse::<i64>().ok());
    Ok((expires_at, paused))
}

fn load_daily_total(conn: &Connection, date_ymd: &str) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT COALESCE(SUM(active_seconds), 0) FROM daily_summary WHERE date = ?1",
            [date_ymd],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0))
}

fn migrate_legacy_db_if_applicable(username: &str, user_db_path: &std::path::Path) {
    // Already migrated or brand-new user — nothing to do.
    if user_db_path.exists() {
        return;
    }
    let legacy = match crate::config::legacy_db_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    if !legacy.exists() {
        return;
    }

    // Only adopt when this user is plausibly "the" single child from the old
    // install: allowed_users is either empty (never-configured) or contains
    // just this user. If multiple children are already listed, we can't know
    // whose silo the legacy DB belongs to — leave it alone and let every
    // child start fresh rather than silently inheriting another's pairing.
    let cfg = match crate::config::load() {
        Ok(c) => c,
        Err(_) => return,
    };
    let matches_single_child = cfg.allowed_users.is_empty()
        || (cfg.allowed_users.len() == 1
            && cfg.allowed_users[0].eq_ignore_ascii_case(username));
    if !matches_single_child {
        log::info!(
            "legacy DB present but allowed_users has {} entries — not migrating for {username}",
            cfg.allowed_users.len()
        );
        return;
    }

    if let Some(parent) = user_db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(&legacy, user_db_path) {
        Ok(()) => log::info!(
            "migrated legacy DB → {} for user '{}'",
            user_db_path.display(),
            username
        ),
        Err(e) => log::warn!(
            "legacy DB migration failed ({} → {}): {e:#}",
            legacy.display(),
            user_db_path.display()
        ),
    }
    // Also sweep the WAL / SHM siblings sqlite may have left behind.
    for ext in ["sqlite-wal", "sqlite-shm"] {
        let from = legacy.with_extension(ext);
        let to = user_db_path.with_extension(ext);
        if from.exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
}

fn default_schedule() -> Schedule {
    // All fields unrestricted until the parent app pushes a real schedule.
    // See schedule::evaluate for the 0 / empty-vec conventions.
    Schedule {
        allowed_ranges: vec![],
        daily_limit_minutes: 0,
        per_app_limits: HashMap::new(),
    }
}

fn today_local(tz: &Tz) -> NaiveDate {
    Utc::now().with_timezone(tz).date_naive()
}
