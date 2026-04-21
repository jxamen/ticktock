import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DeviceState } from "@ticktock/shared";

export function Tray() {
  const [state, setState] = useState<DeviceState | null>(null);
  const [otpMinutes, setOtpMinutes] = useState("30");
  const [issuedPin, setIssuedPin] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpBusy, setOtpBusy] = useState(false);

  const lockNow = async () => {
    try { await invoke("lock_now"); } catch { /* ignore */ }
  };

  useEffect(() => {
    const tick = async () => {
      try {
        setState(await invoke<DeviceState>("get_current_state"));
      } catch { /* agent may not be ready yet */ }
    };
    tick();
    const h = setInterval(tick, 5000);
    return () => clearInterval(h);
  }, []);

  const issue = async () => {
    setOtpError(null);
    const minutes = parseInt(otpMinutes, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setOtpError("분은 1 이상 숫자여야 합니다.");
      return;
    }
    setOtpBusy(true);
    try {
      const pin = await invoke<string>("issue_one_time_pin", { pin: null, minutes });
      setIssuedPin(pin);
    } catch (e) {
      setOtpError(String(e));
    } finally {
      setOtpBusy(false);
    }
  };

  return (
    <div style={{ padding: 16, minWidth: 320 }}>
      <h2 style={{ marginTop: 0 }}>TickTock</h2>
      {state ? (
        <>
          <div>상태: {state.locked ? "잠금" : "사용 중"}</div>
          <div>오늘 사용: {state.todayUsedMinutes}분</div>
          <div>사유: {state.lockReason}</div>
        </>
      ) : (
        <div>연결 중…</div>
      )}

      <button
        onClick={lockNow}
        style={{
          marginTop: 12,
          width: "100%",
          padding: "10px",
          background: "#ef4444",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        즉시 잠금
      </button>

      <hr style={{ margin: "16px 0", borderColor: "#333" }} />

      <h3 style={{ margin: "8px 0" }}>1회성 PIN 발급</h3>
      <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
        자녀에게 알려주고, 오버레이에서 PIN 입력 시점부터 지정한 분만큼 해제됩니다.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="number"
          min={1}
          value={otpMinutes}
          onChange={(e) => setOtpMinutes(e.target.value)}
          style={{ width: 80, padding: 6, background: "#1a1d22", color: "#fff", border: "1px solid #333", borderRadius: 6 }}
        />
        <span>분</span>
        <button
          onClick={issue}
          disabled={otpBusy}
          style={{
            marginLeft: "auto",
            padding: "8px 14px",
            background: otpBusy ? "#374151" : "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: otpBusy ? "not-allowed" : "pointer",
          }}
        >
          {otpBusy ? "발급 중…" : "발급"}
        </button>
      </div>
      {issuedPin && (
        <div style={{ marginTop: 12, padding: 12, background: "#1e3a8a", borderRadius: 8, textAlign: "center" }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>PIN (자녀에게 전달)</div>
          <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: 4, fontVariantNumeric: "tabular-nums" }}>{issuedPin}</div>
        </div>
      )}
      {otpError && <div style={{ marginTop: 8, color: "#f87171" }}>{otpError}</div>}
    </div>
  );
}
