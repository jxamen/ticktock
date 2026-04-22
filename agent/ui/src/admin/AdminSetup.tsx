import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Admin setup console — rendered only in the "admin" Tauri window, which
// opens for Windows administrator sessions (parents).
//
// Scope (v0.1.9+): this console manages ONLY the list of child Windows
// accounts this PC is restricted for. PIN and pairing are now per-child —
// each child Windows account runs its own agent instance with its own DB,
// device id, PIN, schedule, and usage. The child handles their own first-run
// PIN + pairing from their own Windows login (overlay UI). The parent just
// needs to (a) create the child Windows accounts in Windows itself, and
// (b) register those account names here so the overlay activates when the
// child logs in.
//
// Why the simpler UI: earlier v0.1.8 builds exposed a single global PIN and
// pairing code from this admin window, which couldn't represent multiple
// siblings on the same PC. Moving that to per-child session state is what
// enables proper "1 PC, parent + child1/2/3, each managed separately" —
// and matches the subscription model where each child = one seat.

export function AdminSetup() {
  const [allowed, setAllowed] = useState<string[] | null>(null);

  const refresh = async () => {
    try {
      const users = await invoke<string[]>("list_allowed_users");
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
        <p style={{ opacity: 0.65, margin: "8px 0 0", lineHeight: 1.55 }}>
          부모(관리자) 계정에서 사용하는 설정 콘솔입니다. 이 창을 닫아도 자녀 계정의 잠금에는 영향이 없습니다.
        </p>
      </header>

      <HowItWorksSection />
      <AllowedUsersSection users={allowed} onChanged={refresh} />

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

function HowItWorksSection() {
  return (
    <Section title="설정 순서">
      <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7, opacity: 0.85 }}>
        <li>Windows 설정에서 각 자녀에게 <strong>표준 사용자 계정</strong>을 만듭니다 (예: <code>child1</code>, <code>child2</code>).</li>
        <li>아래 "자녀 Windows 계정" 에 만든 계정명을 그대로 추가합니다. 관리자 계정(본인)은 추가하지 않습니다.</li>
        <li>자녀 계정으로 Windows 로그인하면 TickTock 이 각 자녀마다 독립적으로:
          <ul style={{ marginTop: 6 }}>
            <li>첫 PIN 설정 화면 표시</li>
            <li>페어링 코드 발급 → 부모 앱에서 해당 자녀로 등록</li>
            <li>각자의 스케줄 / 사용 시간 / 1회성 PIN 을 따로 관리</li>
          </ul>
        </li>
        <li>부모 앱에는 자녀 수만큼의 디바이스가 등록됩니다. 이 수는 구독 플랜의 seat 한도를 따릅니다.</li>
      </ol>
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
    if (!confirm(`'${u}' 계정을 목록에서 제거하시겠습니까?\n(다음 부팅부터는 이 계정에서 오버레이가 뜨지 않습니다. 해당 자녀의 기존 PIN/페어링 데이터는 유지됩니다.)`)) return;
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
        여기에 등록된 계정으로 Windows 에 로그인했을 때만 잠금 오버레이가 실행됩니다.
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
