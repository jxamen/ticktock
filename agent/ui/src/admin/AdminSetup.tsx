import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Admin setup console — rendered only in the "admin" Tauri window, which
// opens for Windows administrator sessions (parents).
//
// v0.1.13+: the admin console IS the parent's primary control surface on
// the PC. It enumerates the child Windows accounts registered in
// allowed_users and exposes per-child management: one-time PIN issue /
// adjust / revoke, bonus minutes, today-usage reset, main-PIN reset,
// seat-aware registration toggle. Each child's state is read directly
// from their per-user sqlite DB at %ProgramData%\TickTock\users\{u}\
// — no Firebase roundtrip needed; the child's agent picks up the
// updates on its next bootstrap (which is "next time the child logs in"
// because single console user semantics apply).
//
// The web console exists separately for the SaaS operator flow; the
// parent-on-PC flow does not rely on it.

type LocalUser = {
  username: string;
  displayName: string;
  isAdmin: boolean;
  isCurrent: boolean;
  allowed: boolean;
};

type AllowedUsersPayload = {
  users: LocalUser[];
  seatLimit: number | null;
  seatUsed: number;
};

type ChildStatus = {
  username: string;
  displayName: string;
  hasDb: boolean;
  paired: boolean;
  hasPin: boolean;
  todayUsedMinutes: number;
  dailyLimitMinutes: number;
  scheduleJson: string | null;
  hasTempPin: boolean;
  tempPinMinutes: number | null;
  sessionExpiresAtMs: number | null;
  sessionPausedSeconds: number | null;
};

export function AdminSetup() {
  const [payload, setPayload] = useState<AllowedUsersPayload | null>(null);
  const [children, setChildren] = useState<ChildStatus[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [p, cs] = await Promise.all([
        invoke<AllowedUsersPayload>("list_local_users"),
        invoke<ChildStatus[]>("child_list_status"),
      ]);
      setPayload(p);
      setChildren(cs);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const h = setInterval(refresh, 3000);
    return () => clearInterval(h);
  }, []);

  const toggle = async (user: LocalUser, allow: boolean) => {
    try {
      await invoke("set_allowed_user", { username: user.username, allow });
      refresh();
    } catch (e) {
      alert(String(e));
    }
  };

  return (
    <div style={{ padding: 28, minHeight: "100vh", color: "#e5e7eb", background: "#0b0d10", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>TickTock 관리자 콘솔</h1>
        <p style={{ opacity: 0.65, margin: "6px 0 0", fontSize: 13, lineHeight: 1.5 }}>
          이 창에서 자녀별 PIN 발급·시간 조정·사용량 조회·스케줄 변경을 모두 제어합니다.
          자녀가 로그인하면 여기서 저장한 내용이 자동 반영됩니다.
        </p>
      </header>

      {err && (
        <div style={{ background: "#3f1d1d", border: "1px solid #7f1d1d", borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 13, color: "#fecaca" }}>
          상태 조회 실패: {err}
        </div>
      )}

      {payload && <SeatBanner used={payload.seatUsed} limit={payload.seatLimit} />}

      <Section title="자녀 관리">
        {!children ? (
          <div style={{ opacity: 0.5 }}>불러오는 중…</div>
        ) : children.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: "italic", fontSize: 13 }}>
            아직 등록된 자녀 계정이 없습니다. 아래 "이 PC 의 Windows 계정" 섹션에서 자녀를 토글로 등록하세요.
          </div>
        ) : (
          children.map(c => <ChildCard key={c.username} status={c} onChanged={refresh} />)
        )}
      </Section>

      <Section title="이 PC 의 Windows 계정">
        {!payload ? (
          <div style={{ opacity: 0.5 }}>불러오는 중…</div>
        ) : payload.users.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: "italic" }}>
            표시할 계정이 없습니다. Windows 설정에서 자녀용 계정을 먼저 만드세요.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {payload.users.map(u => (
              <UserRow
                key={u.username}
                user={u}
                seatFull={!u.allowed && payload.seatLimit !== null && payload.seatUsed >= payload.seatLimit}
                onToggle={allow => toggle(u, allow)}
              />
            ))}
          </ul>
        )}
      </Section>

      <footer style={{ marginTop: 24, opacity: 0.5, fontSize: 13 }}>
        <button
          onClick={() => getCurrentWindow().close()}
          style={{ padding: "10px 20px", background: "#1f2937", color: "#e5e7eb", border: "1px solid #374151", borderRadius: 6, cursor: "pointer" }}
        >
          창 닫기
        </button>
      </footer>
    </div>
  );
}

function SeatBanner({ used, limit }: { used: number; limit: number | null }) {
  if (limit === null) {
    return (
      <div style={bannerStyle(false)}>
        자녀 등록: <strong style={{ color: "#f1f5f9" }}>{used}명</strong>
        {" · "}<span style={{ opacity: 0.7 }}>구독 한도 미설정 (웹 SaaS 운영자가 설정하면 자동 반영)</span>
      </div>
    );
  }
  const full = used >= limit;
  return (
    <div style={bannerStyle(full)}>
      자녀 등록: <strong style={{ color: full ? "#fecaca" : "#f1f5f9" }}>{used} / {limit}</strong>
      {full && <span style={{ marginLeft: 12, opacity: 0.85 }}>· seat 한도에 도달했습니다.</span>}
    </div>
  );
}

function bannerStyle(warn: boolean): React.CSSProperties {
  return {
    background: warn ? "#3f1d1d" : "#14171c",
    border: `1px solid ${warn ? "#7f1d1d" : "#1f2328"}`,
    borderRadius: 10,
    padding: "12px 16px",
    marginBottom: 16,
    fontSize: 14,
  };
}

function ChildCard({ status: c, onChanged }: { status: ChildStatus; onChanged: () => void }) {
  const primaryName = c.displayName || c.username;
  const sessionRemaining = c.sessionExpiresAtMs ? Math.max(0, Math.floor((c.sessionExpiresAtMs - Date.now()) / 1000)) : null;

  return (
    <div style={{ background: "#0e141b", border: "1px solid #1f2937", borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{primaryName}</div>
          {c.displayName && c.displayName !== c.username && (
            <div style={{ fontSize: 12, opacity: 0.55, fontFamily: "ui-monospace, Consolas, monospace", marginTop: 2 }}>
              {c.username}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {!c.hasDb && <Badge color="#3f3f46" border="#52525b">미초기화</Badge>}
          {c.paired && <Badge color="#065f46" border="#047857">페어링됨</Badge>}
          {!c.paired && c.hasDb && <Badge color="#3f1d1d" border="#7f1d1d">미페어링</Badge>}
          {c.hasPin && <Badge color="#1e3a8a" border="#1d4ed8">PIN 설정됨</Badge>}
          {c.hasTempPin && <Badge color="#78350f" border="#92400e">1회성 PIN 활성</Badge>}
        </div>
      </div>

      {!c.hasDb ? (
        <div style={{ marginTop: 12, opacity: 0.65, fontSize: 13 }}>
          이 자녀가 자신의 Windows 계정으로 아직 로그인하지 않았습니다. 첫 로그인 후 PIN 설정 + 페어링이 진행됩니다.
        </div>
      ) : (
        <>
          <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
            <InfoItem label="오늘 사용" value={`${c.todayUsedMinutes}분 / ${c.dailyLimitMinutes > 0 ? `${c.dailyLimitMinutes}분` : "제한 없음"}`} />
            {c.hasTempPin && (
              <InfoItem label="1회성 PIN" value={`${c.tempPinMinutes ?? 0}분 할당`} />
            )}
            {sessionRemaining !== null && (
              <InfoItem label="세션 남은 시간" value={fmtSeconds(sessionRemaining)} />
            )}
            {c.sessionPausedSeconds !== null && c.sessionPausedSeconds !== undefined && (
              <InfoItem label="일시 중지됨" value={fmtSeconds(c.sessionPausedSeconds)} />
            )}
          </div>

          <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <IssuePinButton username={c.username} onDone={onChanged} />
            {c.hasTempPin && (
              <>
                <AdjustPinButton username={c.username} current={c.tempPinMinutes ?? 0} onDone={onChanged} />
                <ActionButton
                  label="1회성 PIN 취소"
                  variant="danger"
                  onClick={async () => {
                    if (!confirm(`'${primaryName}' 의 1회성 PIN 을 취소할까요?`)) return;
                    try {
                      await invoke("child_revoke_temp_pin", { username: c.username });
                      onChanged();
                    } catch (e) { alert(String(e)); }
                  }}
                />
              </>
            )}
            <GrantBonusButton username={c.username} onDone={onChanged} />
            <ActionButton
              label="오늘 사용시간 리셋"
              onClick={async () => {
                if (!confirm(`'${primaryName}' 의 오늘 사용시간 기록을 0 으로 리셋할까요?`)) return;
                try {
                  await invoke("child_reset_today_usage", { username: c.username });
                  onChanged();
                } catch (e) { alert(String(e)); }
              }}
            />
            {c.hasPin && (
              <ActionButton
                label="PIN 초기화"
                variant="danger"
                onClick={async () => {
                  if (!confirm(`'${primaryName}' 의 메인 PIN 을 초기화할까요? 다음 로그인 때 자녀가 새 PIN 을 설정합니다.`)) return;
                  try {
                    await invoke("child_clear_main_pin", { username: c.username });
                    onChanged();
                  } catch (e) { alert(String(e)); }
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function IssuePinButton({ username, onDone }: { username: string; onDone: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [pin, setPin] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = parseInt(minutes, 10);
    if (!Number.isFinite(n) || n <= 0) {
      alert("분은 1 이상이어야 합니다.");
      return;
    }
    setBusy(true);
    try {
      const result = await invoke<string>("child_issue_temp_pin", {
        username,
        pin: pin.trim() || null,
        minutes: n,
      });
      alert(`1회성 PIN 발급: ${result}\n(자녀에게 이 숫자를 알려주세요. 첫 입력 시점부터 ${n}분간 잠금 해제.)`);
      setPin("");
      setMinutes("30");
      setShowForm(false);
      onDone();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!showForm) {
    return <ActionButton label="1회성 PIN 발급" variant="primary" onClick={() => setShowForm(true)} />;
  }
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#111827", padding: 8, borderRadius: 6, border: "1px solid #1f2937" }}>
      <input
        type="text"
        inputMode="numeric"
        value={pin}
        onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="PIN (비우면 자동)"
        style={{ ...inputSmall, width: 120 }}
      />
      <input
        type="number"
        min={1}
        value={minutes}
        onChange={e => setMinutes(e.target.value)}
        style={{ ...inputSmall, width: 70 }}
      />
      <span style={{ fontSize: 12, opacity: 0.7 }}>분</span>
      <button onClick={submit} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.5 : 1 }}>발급</button>
      <button onClick={() => setShowForm(false)} style={smallBtn}>취소</button>
    </div>
  );
}

function AdjustPinButton({ username, current, onDone }: { username: string; current: number; onDone: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [minutes, setMinutes] = useState(String(current));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = parseInt(minutes, 10);
    if (!Number.isFinite(n) || n <= 0) {
      alert("분은 1 이상이어야 합니다.");
      return;
    }
    setBusy(true);
    try {
      await invoke("child_adjust_temp_pin", { username, minutes: n });
      setShowForm(false);
      onDone();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!showForm) {
    return <ActionButton label="PIN 시간 조정" onClick={() => setShowForm(true)} />;
  }
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#111827", padding: 8, borderRadius: 6, border: "1px solid #1f2937" }}>
      <input
        type="number"
        min={1}
        value={minutes}
        onChange={e => setMinutes(e.target.value)}
        style={{ ...inputSmall, width: 70 }}
      />
      <span style={{ fontSize: 12, opacity: 0.7 }}>분</span>
      <button onClick={submit} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.5 : 1 }}>저장</button>
      <button onClick={() => setShowForm(false)} style={smallBtn}>취소</button>
    </div>
  );
}

function GrantBonusButton({ username, onDone }: { username: string; onDone: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [minutes, setMinutes] = useState("30");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = parseInt(minutes, 10);
    if (!Number.isFinite(n) || n <= 0) {
      alert("분은 1 이상이어야 합니다.");
      return;
    }
    setBusy(true);
    try {
      await invoke("child_grant_bonus", { username, minutes: n });
      setMinutes("30");
      setShowForm(false);
      onDone();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!showForm) {
    return <ActionButton label="보너스 시간 부여" onClick={() => setShowForm(true)} />;
  }
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#111827", padding: 8, borderRadius: 6, border: "1px solid #1f2937" }}>
      <input
        type="number"
        min={1}
        value={minutes}
        onChange={e => setMinutes(e.target.value)}
        style={{ ...inputSmall, width: 70 }}
      />
      <span style={{ fontSize: 12, opacity: 0.7 }}>분 추가</span>
      <button onClick={submit} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.5 : 1 }}>부여</button>
      <button onClick={() => setShowForm(false)} style={smallBtn}>취소</button>
    </div>
  );
}

function fmtSeconds(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${r}초`;
  return `${r}초`;
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, opacity: 0.55, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 500, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function UserRow({ user, seatFull, onToggle }: { user: LocalUser; seatFull: boolean; onToggle: (allow: boolean) => void }) {
  const disabled = user.isAdmin || seatFull;
  const disabledReason = user.isAdmin ? "관리자 계정은 등록 불가" : seatFull ? "seat 한도 초과" : null;
  const primaryName = user.displayName || user.username;
  const secondary = user.displayName && user.displayName !== user.username ? user.username : null;

  return (
    <li
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 14px",
        background: user.isCurrent ? "#0b2340" : "#0b0d10",
        border: `1px solid ${user.isCurrent ? "#1e3a8a" : "#1f2328"}`,
        borderRadius: 10, marginBottom: 6,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: "#f1f5f9" }}>{primaryName}</span>
          {user.isAdmin && <Badge color="#7c2d12" border="#9a3412">관리자</Badge>}
          {!user.isAdmin && <Badge color="#1e3a8a" border="#1d4ed8">표준 사용자</Badge>}
          {user.isCurrent && <Badge color="#065f46" border="#047857">본인</Badge>}
        </div>
        {secondary && (
          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 3, fontFamily: "ui-monospace, Consolas, monospace" }}>{secondary}</div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 10 }}>
        {disabledReason && <span style={{ fontSize: 11, opacity: 0.6 }}>{disabledReason}</span>}
        <Toggle checked={user.allowed} disabled={disabled} onChange={onToggle} />
      </div>
    </li>
  );
}

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 48, height: 28, borderRadius: 999, border: "none", position: "relative",
        background: disabled ? "#374151" : checked ? "#2563eb" : "#334155",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1, transition: "background 0.15s",
      }}
    >
      <span style={{ position: "absolute", top: 3, left: checked ? 23 : 3, width: 22, height: 22, borderRadius: "50%", background: "#f8fafc", transition: "left 0.15s" }} />
    </button>
  );
}

function Badge({ children, color, border }: { children: React.ReactNode; color: string; border: string }) {
  return (
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: color, border: `1px solid ${border}`, color: "#f1f5f9" }}>
      {children}
    </span>
  );
}

function ActionButton({
  label,
  onClick,
  variant = "default",
}: {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: "primary" | "danger" | "default";
}) {
  const styles: React.CSSProperties = {
    padding: "7px 14px",
    fontSize: 13,
    fontWeight: 500,
    borderRadius: 6,
    cursor: "pointer",
    ...(variant === "primary"
      ? { background: "#2563eb", color: "#fff", border: "1px solid #1d4ed8" }
      : variant === "danger"
      ? { background: "#7f1d1d", color: "#fff", border: "1px solid #991b1b" }
      : { background: "#1f2937", color: "#e5e7eb", border: "1px solid #374151" }),
  };
  return (
    <button onClick={onClick} style={styles}>{label}</button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ background: "#14171c", border: "1px solid #1f2328", borderRadius: 12, padding: 18, marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>{title}</h2>
      {children}
    </section>
  );
}

const inputSmall: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 10px",
  borderRadius: 5,
  border: "1px solid #374151",
  background: "#0b0d10",
  color: "#fff",
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 12px",
  background: "#2563eb",
  color: "#fff",
  border: "1px solid #1d4ed8",
  borderRadius: 5,
  fontSize: 13,
  cursor: "pointer",
};
const smallBtn: React.CSSProperties = {
  padding: "6px 10px",
  background: "#374151",
  color: "#e5e7eb",
  border: "1px solid #4b5563",
  borderRadius: 5,
  fontSize: 13,
  cursor: "pointer",
};
