import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Countdown widget rendered in the "timer" window. Polls the agent once per
// second; Rust's timer::run_watcher handles show/hide so we just render the
// current info.
interface TimerInfo {
  kind: "session" | "daily" | "schedule";
  remainingSeconds: number;
  todayUsedMinutes: number;
  dailyLimitMinutes: number;
  agentVersion: string;
}

export function Timer() {
  const [info, setInfo] = useState<TimerInfo | null>(null);

  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      try {
        const v = await invoke<TimerInfo | null>("get_timer_info");
        if (mounted) setInfo(v);
      } catch {
        if (mounted) setInfo(null);
      }
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => {
      mounted = false;
      clearInterval(h);
    };
  }, []);

  if (!info) return null;

  const usageLine = `오늘 ${formatMinutes(info.todayUsedMinutes)} / 한도 ${
    info.dailyLimitMinutes > 0 ? formatMinutes(info.dailyLimitMinutes) : "없음"
  }`;

  const minimize = () => {
    getCurrentWindow().minimize().catch(() => {});
  };

  return (
    <div style={container}>
      <div
        style={minimizeBtn}
        onClick={minimize}
        title="내리기"
        aria-label="내리기"
      >
        –
      </div>
      <div style={label}>{labelFor(info.kind)}</div>
      <div style={timeStyle}>{formatTime(info.remainingSeconds)}</div>
      <div style={usage}>{usageLine}</div>
      <div style={version}>v{info.agentVersion}</div>
    </div>
  );
}

function formatMinutes(mins: number): string {
  const m = Math.max(0, Math.floor(mins));
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}시간` : `${h}시간 ${r}분`;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function labelFor(kind: TimerInfo["kind"]): string {
  switch (kind) {
    case "session":  return "1회성 PIN 남은 시간";
    case "daily":    return "오늘 남은 시간";
    case "schedule": return "허용 시간 종료까지";
  }
}

const container: React.CSSProperties = {
  height: "100vh",
  width: "100vw",
  boxSizing: "border-box",
  padding: "10px 16px",
  background: "#111827",
  color: "#fff",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  fontFamily: "system-ui, -apple-system, sans-serif",
  userSelect: "none",
  cursor: "default",
  position: "relative",
};

const minimizeBtn: React.CSSProperties = {
  position: "absolute",
  top: 4,
  right: 6,
  width: 22,
  height: 22,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 16,
  color: "#d1d5db",
  cursor: "pointer",
  borderRadius: 4,
  lineHeight: 1,
};

const label: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.7,
  letterSpacing: 0.3,
  marginBottom: 2,
};

const timeStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  lineHeight: 1.05,
};

const usage: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.75,
  marginTop: 4,
  fontVariantNumeric: "tabular-nums",
};

const version: React.CSSProperties = {
  fontSize: 9,
  opacity: 0.4,
  marginTop: 2,
  textAlign: "right",
};
