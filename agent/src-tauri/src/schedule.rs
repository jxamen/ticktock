// Schedule evaluator. Runs on a 60s tick.
//
// Decision inputs:
//   - Schedule.allowed_ranges          : time-of-day windows per weekday
//   - Schedule.daily_limit_minutes     : global cap
//   - Schedule.per_app_limits[process] : per-app cap (enforced by terminating
//                                        the foreground process + showing overlay)
//   - AppState.today_used_minutes()    : accumulated non-idle foreground minutes
//   - AppState.foreground_process_name : current foreground (for app limits)
//
// Output: desired locked-state. The ticker only emits a command when the
// desired state differs from the current state, so there's no overlay flicker.

use anyhow::Result;
use chrono::{Datelike, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};
use tauri::AppHandle;

use crate::{lock, storage::AppState};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedRange {
    pub days: Vec<u8>,
    pub start: String,
    pub end: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    // RTDB drops empty arrays/maps on write, so these fields may be missing
    // from a partial snapshot. Default them instead of failing the whole
    // deserialize and silently keeping a stale schedule.
    #[serde(default)]
    pub allowed_ranges: Vec<AllowedRange>,
    #[serde(default)]
    pub daily_limit_minutes: u32,
    #[serde(default)]
    pub per_app_limits: HashMap<String, u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LockReason {
    Schedule,
    Manual,
    DailyLimit,
    AppLimit,
    Boot,
    Offline,
    TempPinExpired,
}

pub async fn run_ticker(app: AppHandle, state: AppState) {
    // 5s cadence so one-time PIN session expirations re-lock promptly.
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    loop {
        interval.tick().await;
        if let Err(e) = tick(&app, &state).await {
            log::warn!("schedule tick error: {e:#}");
        }
    }
}

async fn tick(app: &AppHandle, state: &AppState) -> Result<()> {
    // 1) One-time-PIN session expiry: if set and past-due, re-lock immediately.
    //    Runs regardless of schedule — session expiry wins over an unrestricted schedule.
    if let Some(expires_at) = state.session_expires_at().await {
        if chrono::Utc::now() >= expires_at {
            state.set_session_expires_at(None).await;
            // Fully consumed — drop the one-time-PIN so it can't be reused.
            let _ = state.clear_temp_pin().await;
            lock::timer::hide(app).await?;
            if !state.is_locked().await {
                lock::overlay::show(app).await?;
                state.set_locked(true, LockReason::TempPinExpired).await;
            }
            return Ok(());
        }
    }

    let schedule = state.current_schedule().await;
    let used = state.today_used_minutes().await;
    let tz = state.timezone().await;
    let now = chrono::Utc::now().with_timezone(&tz);
    let foreground = state.foreground_process_name().await;

    let (desired_locked, new_reason) = evaluate(&schedule, used, now, foreground.as_deref());

    // An active one-time-PIN session overrides schedule-based lock decisions
    // (parent explicitly granted time — don't yank it away early).
    let session_active = state.session_expires_at().await.is_some();
    if session_active && desired_locked {
        return Ok(());
    }

    let currently_locked = state.is_locked().await;
    if desired_locked != currently_locked {
        if desired_locked {
            lock::overlay::show(app).await?;
            state.set_locked(true, new_reason).await;
            lock::timer::hide(app).await?;
        } else {
            // Only auto-release locks that the schedule engine itself put on.
            // Manual (parent command), Boot (fail-closed at startup), and
            // TempPinExpired locks must stay until cleared through their own
            // paths — PIN verify, explicit parent unlock, or pairing completion.
            let current_reason = state.lock_reason().await;
            let schedule_driven = matches!(
                current_reason,
                LockReason::Schedule | LockReason::DailyLimit | LockReason::AppLimit
            );
            if schedule_driven {
                lock::overlay::hide(app).await?;
                state.set_locked(false, LockReason::Manual).await;
            }
        }
    }
    Ok(())
}

pub fn evaluate(
    schedule: &Schedule,
    today_used_minutes: u32,
    now: chrono::DateTime<chrono_tz::Tz>,
    foreground_process: Option<&str>,
) -> (bool, LockReason) {
    // Convention: 0 means "unlimited" and an empty allowed_ranges means
    // "no time-of-day restriction". All fields default to unrestricted so a
    // freshly installed (unpaired) agent doesn't auto-lock after PIN unlock —
    // the parent app configures real limits via setSchedule after pairing.
    if schedule.daily_limit_minutes > 0 && today_used_minutes >= schedule.daily_limit_minutes {
        return (true, LockReason::DailyLimit);
    }

    if let Some(name) = foreground_process {
        if let Some(&limit) = schedule.per_app_limits.get(name) {
            if limit > 0 && today_used_minutes >= limit {
                return (true, LockReason::AppLimit);
            }
        }
    }

    if schedule.allowed_ranges.is_empty() {
        return (false, LockReason::Manual);
    }

    let weekday = iso_weekday(now.weekday());
    let minutes_of_day = now.hour() * 60 + now.minute();
    let in_allowed = schedule.allowed_ranges.iter().any(|r| {
        r.days.contains(&weekday) && {
            let start = parse_hhmm(&r.start).unwrap_or(0);
            let end = parse_hhmm(&r.end).unwrap_or(0);
            minutes_of_day >= start && minutes_of_day < end
        }
    });
    if in_allowed {
        (false, LockReason::Manual)
    } else {
        (true, LockReason::Schedule)
    }
}

// If `now` falls inside one of the allowed ranges, returns how many seconds
// remain until that range ends. Used by the timer widget to count down to the
// moment the schedule engine will re-lock.
pub fn current_window_remaining_seconds(
    schedule: &Schedule,
    now: chrono::DateTime<chrono_tz::Tz>,
) -> Option<i64> {
    let weekday = iso_weekday(now.weekday());
    let current_minutes = now.hour() * 60 + now.minute();
    let current_seconds_in_minute = now.second() as i64;
    for r in &schedule.allowed_ranges {
        if !r.days.contains(&weekday) {
            continue;
        }
        let start = parse_hhmm(&r.start)?;
        let end = parse_hhmm(&r.end)?;
        if current_minutes >= start && current_minutes < end {
            let minutes_left = (end - current_minutes) as i64;
            return Some(minutes_left * 60 - current_seconds_in_minute);
        }
    }
    None
}

// Earliest local datetime >= `now` that falls inside an allowed range.
// Returns None if the schedule has no ranges at all (no restriction) or if
// nothing matches within the next 7 days (pathological config).
pub fn next_allowed_start(
    schedule: &Schedule,
    now: chrono::DateTime<chrono_tz::Tz>,
) -> Option<chrono::DateTime<chrono_tz::Tz>> {
    if schedule.allowed_ranges.is_empty() {
        return None;
    }
    for day_offset in 0..=7 {
        let candidate_date = now.date_naive() + chrono::Duration::days(day_offset);
        let weekday = iso_weekday(candidate_date.weekday());
        let mut candidates: Vec<u32> = schedule
            .allowed_ranges
            .iter()
            .filter(|r| r.days.contains(&weekday))
            .filter_map(|r| parse_hhmm(&r.start))
            .collect();
        candidates.sort();
        for start in candidates {
            let hour = (start / 60) as u32;
            let minute = (start % 60) as u32;
            let naive = candidate_date
                .and_hms_opt(hour, minute, 0)?;
            let tz = now.timezone();
            let candidate = tz.from_local_datetime(&naive).single()?;
            if candidate >= now {
                return Some(candidate);
            }
        }
    }
    None
}

fn iso_weekday(w: chrono::Weekday) -> u8 {
    match w {
        chrono::Weekday::Mon => 1,
        chrono::Weekday::Tue => 2,
        chrono::Weekday::Wed => 3,
        chrono::Weekday::Thu => 4,
        chrono::Weekday::Fri => 5,
        chrono::Weekday::Sat => 6,
        chrono::Weekday::Sun => 7,
    }
}

fn parse_hhmm(s: &str) -> Option<u32> {
    let mut parts = s.split(':');
    let h: u32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    Some(h * 60 + m)
}
