import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Full-screen lock overlay. Decides its mode by asking the agent:
//   1. has_pin === false             → SetupPin (first-run PIN setup)
//   2. has_pin && !paired            → PairingCode (show 6-digit code to parent)
//   3. has_pin && paired             → VerifyPin (normal lock screen)
//
// Mode transitions are driven by polling — Setup → Pairing happens as soon as
// has_pin flips to true, and Pairing → unlocked happens when pairing.rs hides
// the overlay window from Rust.
export function Overlay() {
  const [mode, setMode] = useState<"loading" | "setup" | "pairing" | "verify">("loading");
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const hasPin = await invoke<boolean>("has_pin");
      if (!hasPin) {
        setMode("setup");
        return;
      }
      const status = await invoke<{ paired: boolean; code: string | null }>("get_pairing_status");
      if (status.paired) {
        setMode("verify");
        setPairingCode(null);
      } else {
        setMode("pairing");
        setPairingCode(status.code);
      }
    } catch {
      // agent not ready yet — keep showing loading
    }
  };

  useEffect(() => {
    refresh();
    const h = setInterval(refresh, 1500);
    return () => clearInterval(h);
  }, []);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      {mode === "loading" && <h1 style={{ fontSize: 32, opacity: 0.6 }}>로딩 중…</h1>}
      {mode === "setup" && <SetupPin onDone={refresh} />}
      {mode === "pairing" && <PairingCode code={pairingCode} />}
      {mode === "verify" && <VerifyPin />}
    </div>
  );
}

function SetupPin({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const digitsOnly = (s: string) => s.replace(/\D/g, "").slice(0, 6);
  const pinValid = pin.length >= 4 && pin.length <= 6;
  const matches = pin.length > 0 && pin === confirm;

  const submit = async () => {
    setError(null);
    if (!pinValid) { setError("PIN은 4~6자리 숫자여야 합니다."); return; }
    if (!matches) { setError("두 PIN이 일치하지 않습니다."); return; }
    setBusy(true);
    try {
      await invoke("setup_pin_and_unlock", { pin });
      onDone();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ textAlign: "center", maxWidth: 520 }}>
      <h1 style={{ fontSize: 40, margin: 0 }}>TickTock 첫 실행</h1>
      <p style={{ opacity: 0.8, marginTop: 16, lineHeight: 1.6 }}>
        잠금 해제에 사용할 4~6자리 PIN을 설정해주세요.
        <br />
        부모 앱이 연결되기 전, 이 PC에서 직접 해제할 수 있는 유일한 방법입니다.
      </p>

      <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(digitsOnly(e.target.value))}
          placeholder="새 PIN (4~6자리)"
          style={inputStyle}
        />
        <input
          type="password"
          inputMode="numeric"
          value={confirm}
          onChange={(e) => setConfirm(digitsOnly(e.target.value))}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="PIN 다시 입력"
          style={inputStyle}
        />
        <button
          onClick={submit}
          disabled={busy || !pinValid || !matches}
          style={{
            fontSize: 20,
            padding: "12px 32px",
            marginTop: 8,
            borderRadius: 8,
            border: "none",
            background: busy || !pinValid || !matches ? "#374151" : "#2563eb",
            color: "#fff",
            cursor: busy || !pinValid || !matches ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "설정 중…" : "다음"}
        </button>
        {error && <div style={{ color: "#f87171" }}>{error}</div>}
      </div>
    </div>
  );
}

function PairingCode({ code }: { code: string | null }) {
  return (
    <div style={{ textAlign: "center", maxWidth: 640 }}>
      <h1 style={{ fontSize: 40, margin: 0 }}>부모 앱과 연결하기</h1>
      <p style={{ opacity: 0.8, marginTop: 16, lineHeight: 1.6 }}>
        아래 6자리 코드를 부모 앱에서 입력하세요.
        <br />
        코드는 10분 뒤 자동 갱신됩니다.
      </p>
      <div style={{
        marginTop: 40,
        fontSize: 96,
        fontWeight: 700,
        letterSpacing: 12,
        fontVariantNumeric: "tabular-nums",
        padding: "24px 40px",
        border: "2px solid #2563eb",
        borderRadius: 16,
        display: "inline-block",
      }}>
        {code ?? "——————"}
      </div>
      <p style={{ marginTop: 24, opacity: 0.6, fontSize: 14 }}>연결이 완료되면 자동으로 해제됩니다.</p>
    </div>
  );
}

interface LockStatus {
  locked: boolean;
  reason: string;
  pausedSeconds: number | null;
  nextAllowedAtMs: number | null;
  dailyLimitMinutes: number;
  todayUsedMinutes: number;
}

function VerifyPin() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LockStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await invoke<LockStatus>("get_lock_status");
        if (alive) setStatus(s);
      } catch { /* ignore */ }
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(h); };
  }, []);

  const submit = async () => {
    try {
      const ok = await invoke<boolean>("verify_pin_and_unlock", { pin });
      if (!ok) {
        setError("PIN이 올바르지 않습니다.");
        setPin("");
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const infoLines = buildLockInfo(status);

  return (
    <>
      <h1 style={{ fontSize: 48, margin: 0 }}>사용 시간이 아닙니다</h1>
      <p style={{ opacity: 0.7, marginTop: 12 }}>부모가 발급한 1회성 PIN이 있으면 입력하세요.</p>

      {infoLines.length > 0 && (
        <div style={{ marginTop: 24, textAlign: "center", opacity: 0.85, maxWidth: 720 }}>
          {infoLines.map((line, i) => (
            <div key={i} style={{ fontSize: i === 0 ? 22 : 16, marginTop: i === 0 ? 0 : 6, color: i === 0 ? "#fbbf24" : "#e5e7eb" }}>
              {line}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 48, textAlign: "center" }}>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="PIN"
          style={inputStyle}
        />
        {error && <div style={{ marginTop: 8, color: "#f87171" }}>{error}</div>}
      </div>
    </>
  );
}

function buildLockInfo(status: LockStatus | null): string[] {
  if (!status) return [];
  const lines: string[] = [];
  if (status.pausedSeconds && status.pausedSeconds > 0) {
    lines.push(`⏸ 1회성 PIN 일시정지 — 남은 ${formatDurationSec(status.pausedSeconds)}`);
    lines.push("부모가 '다시 열기'를 누르거나 같은 PIN을 입력하면 이어서 사용할 수 있어요.");
    return lines;
  }
  if (status.reason === "dailylimit") {
    lines.push("📵 오늘 한도 소진");
    if (status.dailyLimitMinutes > 0) {
      lines.push(`오늘 ${status.todayUsedMinutes}분 / 한도 ${status.dailyLimitMinutes}분`);
    }
    lines.push("내일 자정 이후 다시 사용할 수 있어요.");
    return lines;
  }
  if (status.reason === "temppinexpired") {
    lines.push("⏱ 1회성 PIN 시간이 종료되었어요");
    lines.push("부모에게 새 PIN을 요청하세요.");
    return lines;
  }
  if (status.reason === "schedule") {
    if (status.nextAllowedAtMs) {
      lines.push(`📅 다음 사용 가능: ${formatLocalDateTime(status.nextAllowedAtMs)}`);
    } else {
      lines.push("📅 허용 시간대가 아닙니다");
    }
    return lines;
  }
  if (status.reason === "manual") {
    lines.push("🔒 부모가 잠갔습니다");
    return lines;
  }
  return lines;
}

function formatDurationSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const prefix = sameDay ? "오늘" : isTomorrow ? "내일" : `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]})`;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${prefix} ${hh}:${mm}`;
}

const inputStyle: React.CSSProperties = {
  fontSize: 32,
  padding: 12,
  width: 260,
  textAlign: "center",
  borderRadius: 8,
  border: "1px solid #333",
  background: "#1a1d22",
  color: "#fff",
};
