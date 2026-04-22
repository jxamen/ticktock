import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Admin setup console — rendered only in the "admin" Tauri window, which
// opens for Windows administrator sessions (parents). Separate from the
// full-screen child overlay: closable, not on top, just a configuration
// panel. Sections: PIN, child Windows accounts, pairing code.

export function AdminSetup() {
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [paired, setPaired] = useState<boolean | null>(null);
  const [allowed, setAllowed] = useState<string[] | null>(null);

  const refresh = async () => {
    try {
      const [pin, pairing, users] = await Promise.all([
        invoke<boolean>("has_pin"),
        invoke<{ paired: boolean; code: string | null }>("get_pairing_status"),
        invoke<string[]>("list_allowed_users"),
      ]);
      setHasPin(pin);
      setPaired(pairing.paired);
      setPairingCode(pairing.code);
      setAllowed(users);
    } catch {
      // agent still starting — keep showing stale state
    }
  };

  useEffect(() => {
    refresh();
    const h = setInterval(refresh, 2000);
    return () => clearInterval(h);
  }, []);

  return (
    <div style={{ padding: 32, minHeight: "100vh", color: "#e5e7eb", background: "#0b0d10", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>TickTock 관리자 설정</h1>
        <p style={{ opacity: 0.65, margin: "8px 0 0" }}>
          부모(관리자) 계정에서 사용하는 설정 콘솔입니다. 이 창을 닫아도 자녀 계정의 잠금에는 영향이 없습니다.
        </p>
      </header>

      <PinSection hasPin={hasPin} onChanged={refresh} />
      <AllowedUsersSection users={allowed} onChanged={refresh} />
      <PairingSection paired={paired} code={pairingCode} />

      <footer style={{ marginTop: 40, opacity: 0.5, fontSize: 13 }}>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      background: "#14171c",
      border: "1px solid #1f2328",
      borderRadius: 12,
      padding: 20,
      marginBottom: 20,
    }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>{title}</h2>
      {children}
    </section>
  );
}

function PinSection({ hasPin, onChanged }: { hasPin: boolean | null; onChanged: () => void }) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const digits = (s: string) => s.replace(/\D/g, "").slice(0, 6);
  const valid = pin.length >= 4 && pin.length <= 6 && pin === confirm;

  const submit = async () => {
    setErr(null);
    if (!valid) { setErr("PIN은 4~6자리 숫자이고 두 번 일치해야 합니다."); return; }
    setBusy(true);
    try {
      // setup_pin_and_unlock rejects if a PIN already exists, so when
      // changing the PIN we go through set_pin which just overwrites the
      // hash. First-time setup uses setup_pin_and_unlock so the pairing
      // flow kicks in if a device_id is already present.
      if (hasPin) {
        await invoke("set_pin", { pin });
      } else {
        await invoke("setup_pin_and_unlock", { pin });
      }
      setPin(""); setConfirm(""); setShowForm(false);
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="PIN">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{
          width: 10, height: 10, borderRadius: 5,
          background: hasPin ? "#10b981" : "#9ca3af",
        }} />
        <span>{hasPin === null ? "확인 중…" : hasPin ? "설정됨" : "미설정"}</span>
        <button
          onClick={() => setShowForm(v => !v)}
          style={smallBtn}
        >
          {hasPin ? "변경" : "설정"}
        </button>
      </div>
      {showForm && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8, maxWidth: 280 }}>
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={pin}
            onChange={e => setPin(digits(e.target.value))}
            placeholder="새 PIN (4~6자리)"
            style={input}
          />
          <input
            type="password"
            inputMode="numeric"
            value={confirm}
            onChange={e => setConfirm(digits(e.target.value))}
            onKeyDown={e => e.key === "Enter" && submit()}
            placeholder="PIN 다시 입력"
            style={input}
          />
          <button onClick={submit} disabled={busy || !valid} style={{ ...primaryBtn, opacity: busy || !valid ? 0.5 : 1 }}>
            {busy ? "저장 중…" : "저장"}
          </button>
          {err && <div style={{ color: "#f87171", fontSize: 13 }}>{err}</div>}
        </div>
      )}
    </Section>
  );
}

function AllowedUsersSection({ users, onChanged }: { users: string[] | null; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    setErr(null);
    const trimmed = name.trim();
    if (!trimmed) { setErr("자녀 Windows 사용자명을 입력하세요."); return; }
    setBusy(true);
    try {
      await invoke("add_allowed_user", { username: trimmed });
      setName("");
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: string) => {
    if (!confirm(`'${u}' 계정을 목록에서 제거하시겠습니까?\n(다음 부팅부터는 이 계정에서 오버레이가 뜨지 않습니다.)`)) return;
    try {
      await invoke("remove_allowed_user", { username: u });
      onChanged();
    } catch (e) {
      alert(String(e));
    }
  };

  return (
    <Section title="자녀 Windows 계정">
      <p style={{ opacity: 0.7, fontSize: 13, margin: "0 0 12px" }}>
        여기에 등록된 계정으로 Windows 에 로그인했을 때만 잠금 오버레이가 실행됩니다. 부모(관리자) 계정은 등록하지 마세요.
      </p>
      {users === null ? (
        <div style={{ opacity: 0.5 }}>불러오는 중…</div>
      ) : users.length === 0 ? (
        <div style={{ opacity: 0.5, fontStyle: "italic", marginBottom: 12 }}>아직 등록된 자녀 계정이 없습니다.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px" }}>
          {users.map(u => (
            <li key={u} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "8px 12px", background: "#0b0d10", borderRadius: 6, marginBottom: 6,
            }}>
              <span style={{ fontFamily: "monospace" }}>{u}</span>
              <button onClick={() => remove(u)} style={{ ...smallBtn, background: "#7f1d1d", borderColor: "#991b1b" }}>
                제거
              </button>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          placeholder="예: child1"
          style={{ ...input, flex: 1, fontSize: 16 }}
        />
        <button onClick={add} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.5 : 1 }}>
          추가
        </button>
      </div>
      {err && <div style={{ color: "#f87171", fontSize: 13, marginTop: 8 }}>{err}</div>}
    </Section>
  );
}

function PairingSection({ paired, code }: { paired: boolean | null; code: string | null }) {
  return (
    <Section title="부모 앱 페어링">
      {paired === null ? (
        <div style={{ opacity: 0.5 }}>확인 중…</div>
      ) : paired ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: 5, background: "#10b981" }} />
          <span>연결됨</span>
        </div>
      ) : (
        <>
          <p style={{ opacity: 0.7, fontSize: 13, margin: "0 0 12px" }}>
            부모 앱에서 아래 6자리 코드를 입력하면 페어링이 완료됩니다. 코드는 10분마다 갱신됩니다.
          </p>
          <div style={{
            fontSize: 48, fontWeight: 700, letterSpacing: 8,
            fontVariantNumeric: "tabular-nums",
            padding: "16px 24px",
            border: "2px solid #2563eb", borderRadius: 12,
            display: "inline-block",
          }}>
            {code ?? "——————"}
          </div>
        </>
      )}
    </Section>
  );
}

const input: React.CSSProperties = {
  fontSize: 20,
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid #374151",
  background: "#0b0d10",
  color: "#fff",
};
const primaryBtn: React.CSSProperties = {
  padding: "8px 16px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 14,
  cursor: "pointer",
};
const smallBtn: React.CSSProperties = {
  padding: "4px 12px",
  background: "#1f2937",
  color: "#e5e7eb",
  border: "1px solid #374151",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
};
