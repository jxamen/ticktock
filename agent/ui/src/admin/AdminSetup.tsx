import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Admin setup console — rendered only in the "admin" Tauri window, which
// opens for Windows administrator sessions (parents).
//
// v0.1.10: replaces the typed-username flow with an auto-enumerated picker.
// The Rust side scans local Windows accounts (NetUserEnum + display name +
// Administrators group membership) so the parent can toggle children from
// a list instead of running `whoami` on every child's session.
//
// Per-child isolation: toggling a user on here only adds their SAM name to
// config.allowed_users — PIN, pairing, schedule, and usage remain per-child
// and are initialised the first time that child logs into Windows and the
// overlay guides them through setup.

type LocalUser = {
  username: string;
  displayName: string;
  isAdmin: boolean;
  isCurrent: boolean;
  allowed: boolean;
};

type Payload = {
  users: LocalUser[];
  seatLimit: number | null;
  seatUsed: number;
};

export function AdminSetup() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const p = await invoke<Payload>("list_local_users");
      setPayload(p);
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
    <div style={{ padding: 32, minHeight: "100vh", color: "#e5e7eb", background: "#0b0d10", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>TickTock 관리자 설정</h1>
        <p style={{ opacity: 0.65, margin: "8px 0 0", lineHeight: 1.55 }}>
          자녀 계정을 토글로 등록하세요. 각 자녀는 본인 계정으로 로그인 시 PIN 설정 + 페어링을 각자 진행합니다.
        </p>
      </header>

      {payload && <SeatBanner used={payload.seatUsed} limit={payload.seatLimit} />}

      <Section title="이 PC 의 Windows 계정">
        {err && (
          <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12 }}>
            계정 목록 조회 실패: {err}
          </div>
        )}
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

      <HowItWorks />

      <footer style={{ marginTop: 32, opacity: 0.5, fontSize: 13 }}>
        <button
          onClick={() => getCurrentWindow().close()}
          style={{
            padding: "10px 20px",
            background: "#1f2937",
            color: "#e5e7eb",
            border: "1px solid #374151",
            borderRadius: 6,
            cursor: "pointer",
          }}
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
        현재 등록된 자녀: <strong style={{ color: "#f1f5f9" }}>{used}명</strong>
        {" · "}
        <span style={{ opacity: 0.7 }}>구독 한도 미설정 (웹에서 플랜 연결 후 자동 반영)</span>
      </div>
    );
  }
  const full = used >= limit;
  return (
    <div style={bannerStyle(full)}>
      자녀 등록: <strong style={{ color: full ? "#fecaca" : "#f1f5f9" }}>{used} / {limit}</strong>
      {full && <span style={{ marginLeft: 12, opacity: 0.85 }}>· 구독 seat 한도에 도달했습니다. 추가하려면 웹에서 플랜을 늘려주세요.</span>}
    </div>
  );
}

function bannerStyle(warn: boolean): React.CSSProperties {
  return {
    background: warn ? "#3f1d1d" : "#14171c",
    border: `1px solid ${warn ? "#7f1d1d" : "#1f2328"}`,
    borderRadius: 10,
    padding: "12px 16px",
    marginBottom: 20,
    fontSize: 14,
  };
}

function UserRow({
  user,
  seatFull,
  onToggle,
}: {
  user: LocalUser;
  seatFull: boolean;
  onToggle: (allow: boolean) => void;
}) {
  const disabled = user.isAdmin || seatFull;
  const disabledReason = user.isAdmin
    ? "관리자 계정은 등록 불가"
    : seatFull
    ? "seat 한도 초과"
    : null;

  const primaryName = user.displayName || user.username;
  const secondary = user.displayName && user.displayName !== user.username ? user.username : null;

  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 16px",
        background: user.isCurrent ? "#0b2340" : "#0b0d10",
        border: `1px solid ${user.isCurrent ? "#1e3a8a" : "#1f2328"}`,
        borderRadius: 10,
        marginBottom: 8,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: "#f1f5f9" }}>{primaryName}</span>
          {user.isAdmin && <Badge color="#7c2d12" border="#9a3412">관리자</Badge>}
          {!user.isAdmin && <Badge color="#1e3a8a" border="#1d4ed8">표준 사용자</Badge>}
          {user.isCurrent && <Badge color="#065f46" border="#047857">본인</Badge>}
        </div>
        {secondary && (
          <div style={{ fontSize: 12, opacity: 0.55, marginTop: 4, fontFamily: "ui-monospace, Consolas, monospace" }}>
            {secondary}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: 12 }}>
        {disabledReason && (
          <span style={{ fontSize: 12, opacity: 0.6 }}>{disabledReason}</span>
        )}
        <Toggle checked={user.allowed} disabled={disabled} onChange={onToggle} />
      </div>
    </li>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 52,
        height: 30,
        borderRadius: 999,
        border: "none",
        position: "relative",
        background: disabled ? "#374151" : checked ? "#2563eb" : "#334155",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.15s",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 25 : 3,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: "#f8fafc",
          transition: "left 0.15s",
        }}
      />
    </button>
  );
}

function Badge({ children, color, border }: { children: React.ReactNode; color: string; border: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 999,
        background: color,
        border: `1px solid ${border}`,
        color: "#f1f5f9",
      }}
    >
      {children}
    </span>
  );
}

function HowItWorks() {
  return (
    <Section title="설정 순서">
      <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, opacity: 0.85, fontSize: 14 }}>
        <li>위 목록에서 자녀용 <strong>표준 사용자</strong> 계정의 토글을 켭니다.</li>
        <li>해당 자녀가 본인 Windows 계정으로 로그인하면 TickTock 이 자동 실행되며 PIN 설정 + 페어링 코드 화면이 뜹니다.</li>
        <li>부모 앱(모바일/웹)에서 그 코드를 입력해 자녀별 device 로 등록합니다.</li>
        <li>자녀마다 스케줄·사용 시간·1회성 PIN 을 **따로** 관리하게 됩니다. 구독 seat 한 개 = 자녀 한 명.</li>
      </ol>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: "#14171c",
        border: "1px solid #1f2328",
        borderRadius: 12,
        padding: 20,
        marginBottom: 20,
      }}
    >
      <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>{title}</h2>
      {children}
    </section>
  );
}
