// Firebase RTDB schema shared between agent and mobile.
// Keep in sync with agent/src-tauri/src/firebase.rs serde types.

export type DeviceId = string;
export type UserId = string;

// Weekday numbers: 1 = Monday ... 7 = Sunday (ISO 8601).
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface AllowedRange {
  days: Weekday[];
  start: string; // "HH:MM" local time
  end: string;   // "HH:MM" local time (exclusive)
}

export interface Schedule {
  allowedRanges: AllowedRange[];
  dailyLimitMinutes: number;
  perAppLimits: Record<string, number>; // processName -> minutes
}

export type LockReason = "schedule" | "manual" | "dailyLimit" | "appLimit" | "boot" | "offline" | "tempPinExpired";

export interface DeviceMeta {
  name: string;
  registeredAt: number;  // epoch ms
  timezone: string;      // IANA, e.g. "Asia/Seoul"
  agentVersion?: string;
}

export interface DeviceState {
  locked: boolean;
  lockReason: LockReason;
  lastHeartbeat: number;
  onlineUser: string | null;
  todayUsedMinutes: number;
  agentVersion: string;
  // Epoch ms when the current one-time-PIN session expires. Null/missing
  // when no session is active or the session is paused (see sessionPausedSeconds).
  sessionExpiresAt?: number | null;
  // When the parent locks during a running session, the remaining seconds are
  // parked here so a later unlock can resume. Null/missing when no paused
  // session is waiting.
  sessionPausedSeconds?: number | null;
}

// Commands are write-once from parent, consumed by agent.
export type CommandType =
  | "lock"
  | "unlock"
  | "setSchedule"
  | "setAppLimit"
  | "grantBonus"
  | "issueOneTimePin"
  | "revokeOneTimePin"
  | "adjustOneTimePin"
  | "resetTodayUsage";

export interface BaseCommand {
  type: CommandType;
  issuedAt: number;     // epoch ms
  issuedBy: UserId;
  consumed: boolean;
  consumedAt: number | null;
}

export interface LockCommand extends BaseCommand {
  type: "lock";
  payload: { reason?: string };
}

export interface UnlockCommand extends BaseCommand {
  type: "unlock";
  payload: { durationMinutes?: number }; // optional auto-relock after N min
}

export interface SetScheduleCommand extends BaseCommand {
  type: "setSchedule";
  payload: Schedule;
}

export interface SetAppLimitCommand extends BaseCommand {
  type: "setAppLimit";
  payload: { processName: string; minutes: number | null }; // null = remove
}

export interface GrantBonusCommand extends BaseCommand {
  type: "grantBonus";
  payload: { minutes: number };
}

// Issues a one-time PIN that unlocks for `minutes` and is consumed on use.
// The parent app generates `pin` (plaintext) locally and shows it to the child;
// the agent hashes + stores it and clears `pin` from the command on consume.
export interface IssueOneTimePinCommand extends BaseCommand {
  type: "issueOneTimePin";
  payload: { pin: string; minutes: number };
}

// Cancels the currently stored one-time PIN and any running/paused session
// for it. Overlay relocks if the child was unlocked by the session.
export interface RevokeOneTimePinCommand extends BaseCommand {
  type: "revokeOneTimePin";
  payload: Record<string, never>;
}

// Changes the minutes associated with the current one-time PIN. If a session
// is active, its remaining time is re-aimed to `minutes`.
export interface AdjustOneTimePinCommand extends BaseCommand {
  type: "adjustOneTimePin";
  payload: { minutes: number };
}

// Zeroes today's usage totals on the agent (local SQLite) and clears
// /devices/{id}/usage/{today} in RTDB so the parent app reflects it.
export interface ResetTodayUsageCommand extends BaseCommand {
  type: "resetTodayUsage";
  payload: Record<string, never>;
}

export type Command =
  | LockCommand
  | UnlockCommand
  | SetScheduleCommand
  | SetAppLimitCommand
  | GrantBonusCommand
  | IssueOneTimePinCommand
  | RevokeOneTimePinCommand
  | AdjustOneTimePinCommand
  | ResetTodayUsageCommand;

// Usage: per-day, per-process, seconds of active (non-idle) foreground time.
export type UsageByProcess = Record<string, number>; // processName -> seconds
export type DailyUsage = UsageByProcess;             // keyed by YYYY-MM-DD externally

// Device node in RTDB.
export interface Device {
  meta: DeviceMeta;
  state: DeviceState;
  schedule: Schedule;
  commands: Record<string, Command>;
  usage: Record<string, DailyUsage>; // YYYY-MM-DD -> { process: seconds }
}
