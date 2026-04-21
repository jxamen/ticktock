import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  ScrollView,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { onValue, ref } from "firebase/database";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  auth,
  db,
  issueCommand,
  issueOneTimePin,
  subscribeToSchedule,
  subscribeToState,
} from "../firebase";
import {
  paths,
  type DeviceId,
  type DeviceMeta,
  type DeviceState,
  type Schedule,
} from "@ticktock/shared";
import type { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Devices">;

const OTP_PRESETS: { minutes: number; label: string }[] = [
  { minutes: 10, label: "10분" },
  { minutes: 30, label: "30분" },
  { minutes: 60, label: "1시간" },
  { minutes: 120, label: "2시간" },
  { minutes: 180, label: "3시간" },
];

export function DevicesScreen({ navigation }: Props) {
  const [devices, setDevices] = useState<DeviceId[]>([]);

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    return onValue(ref(db, paths.userDevices(uid)), (snap) => {
      setDevices(Object.keys(snap.val() ?? {}));
    });
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.root}>
      {devices.length === 0 && (
        <Text style={styles.empty}>
          등록된 디바이스가 없습니다. 아래 버튼으로 PC 페어링 코드를 입력하세요.
        </Text>
      )}

      {devices.map((id) => (
        <DeviceCard key={id} deviceId={id} navigation={navigation} />
      ))}

      <Pressable
        style={styles.addBtn}
        onPress={() => navigation.navigate("Pairing")}
      >
        <Text style={styles.addBtnText}>+ PC 추가 연결</Text>
      </Pressable>
    </ScrollView>
  );
}

interface OtpHistoryEntry {
  id: string;
  minutes: number;
  issuedAt: number;
  consumed: boolean;
  consumedAt: number | null;
}

function DeviceCard({
  deviceId,
  navigation,
}: {
  deviceId: DeviceId;
  navigation: Props["navigation"];
}) {
  const [meta, setMeta] = useState<DeviceMeta | null>(null);
  const [state, setState] = useState<DeviceState | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [history, setHistory] = useState<OtpHistoryEntry[]>([]);

  const [selectedMinutes, setSelectedMinutes] = useState<number>(30);
  const [issuedPin, setIssuedPin] = useState<string | null>(null);
  const [otpBusy, setOtpBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Tick every second while a session is active so remaining time is live.
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    if (!state?.sessionExpiresAt) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [state?.sessionExpiresAt]);

  useEffect(
    () =>
      onValue(ref(db, paths.deviceMeta(deviceId)), (snap) =>
        setMeta(snap.val() as DeviceMeta | null),
      ),
    [deviceId],
  );
  useEffect(
    () => subscribeToState(deviceId, (v) => setState(v as DeviceState | null)),
    [deviceId],
  );
  useEffect(() => subscribeToSchedule(deviceId, (s) => setSchedule(s)), [deviceId]);
  useEffect(
    () =>
      onValue(ref(db, paths.deviceCommands(deviceId)), (snap) => {
        const raw = (snap.val() ?? {}) as Record<string, any>;
        const items: OtpHistoryEntry[] = Object.entries(raw)
          .filter(([, v]) => v?.type === "issueOneTimePin")
          .map(([id, v]) => ({
            id,
            minutes: Number(v?.payload?.minutes ?? 0),
            issuedAt: Number(v?.issuedAt ?? 0),
            consumed: Boolean(v?.consumed),
            consumedAt: v?.consumedAt ?? null,
          }))
          .sort((a, b) => b.issuedAt - a.issuedAt)
          .slice(0, 5);
        setHistory(items);
      }),
    [deviceId],
  );

  const locked = state?.locked ?? true;
  const online =
    state && Date.now() - (state.lastHeartbeat ?? 0) < 60_000;

  const sessionRemainingSec = useMemo(() => {
    if (!state?.sessionExpiresAt) return 0;
    return Math.max(0, Math.floor((state.sessionExpiresAt - now) / 1000));
  }, [state?.sessionExpiresAt, now]);

  const pausedSec = Math.max(0, state?.sessionPausedSeconds ?? 0);
  const hasPausedSession = locked && pausedSec > 0;

  const sendLock = async (type: "lock" | "unlock") => {
    // Lock now pauses the session (remaining time preserved) — no scary
    // confirmation needed. Unlock resumes it automatically.
    try {
      const uid = auth.currentUser?.uid ?? "anonymous";
      await issueCommand(deviceId, type, {}, uid);
    } catch (e) {
      Alert.alert("전송 실패", String(e));
    }
  };

  const resetUsage = () => {
    Alert.alert(
      "오늘 사용 시간 리셋",
      "오늘의 누적 사용 시간을 0으로 초기화합니다. 계속할까요?",
      [
        { text: "취소", style: "cancel" },
        {
          text: "리셋",
          style: "destructive",
          onPress: async () => {
            try {
              const uid = auth.currentUser?.uid ?? "anonymous";
              await issueCommand(deviceId, "resetTodayUsage", {}, uid);
            } catch (e) {
              Alert.alert("전송 실패", String(e));
            }
          },
        },
      ],
    );
  };

  const issueOtp = async () => {
    setOtpBusy(true);
    setCopied(false);
    try {
      const uid = auth.currentUser?.uid ?? "anonymous";
      const pin = await issueOneTimePin(deviceId, selectedMinutes, uid);
      setIssuedPin(pin);
    } catch (e) {
      Alert.alert("발급 실패", String(e));
    } finally {
      setOtpBusy(false);
    }
  };

  const copyPin = async () => {
    if (!issuedPin) return;
    await Clipboard.setStringAsync(issuedPin);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const revokePin = () => {
    Alert.alert("1회성 PIN 취소", "현재 PIN과 진행 중인 세션을 모두 취소합니다.", [
      { text: "닫기", style: "cancel" },
      {
        text: "취소 실행",
        style: "destructive",
        onPress: async () => {
          try {
            const uid = auth.currentUser?.uid ?? "anonymous";
            await issueCommand(deviceId, "revokeOneTimePin", {}, uid);
            setIssuedPin(null);
            setCopied(false);
          } catch (e) {
            Alert.alert("전송 실패", String(e));
          }
        },
      },
    ]);
  };

  const adjustPin = async (newMinutes: number) => {
    try {
      const uid = auth.currentUser?.uid ?? "anonymous";
      await issueCommand(deviceId, "adjustOneTimePin", { minutes: newMinutes }, uid);
      setSelectedMinutes(newMinutes);
    } catch (e) {
      Alert.alert("전송 실패", String(e));
    }
  };

  const displayName =
    meta?.name && meta.name.trim().length > 0
      ? meta.name
      : `PC (${deviceId.slice(0, 8)})`;

  const statusText = locked
    ? hasPausedSession
      ? `⏸ 1회성 PIN 일시정지 · ${formatDuration(pausedSec)} 남음`
      : "🔒 잠금"
    : sessionRemainingSec > 0
      ? `⏱ 1회성 PIN 사용 중 · ${formatDuration(sessionRemainingSec)} 남음`
      : "🔓 사용 중";
  const statusBg = locked
    ? hasPausedSession
      ? "#fef3c7"
      : "#fee2e2"
    : sessionRemainingSec > 0
      ? "#fef3c7"
      : "#d1fae5";

  const todayUsed = state?.todayUsedMinutes ?? 0;
  const dailyLimit = schedule?.dailyLimitMinutes ?? 0;
  const dailyRemaining = dailyLimit > 0 ? Math.max(0, dailyLimit - todayUsed) : null;
  const dailyPct = dailyLimit > 0 ? Math.min(100, (todayUsed / dailyLimit) * 100) : 0;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.deviceName}>{displayName}</Text>
        <Text style={[styles.dot, { color: online ? "#10b981" : "#9ca3af" }]}>
          {online ? "● 온라인" : "○ 오프라인"}
        </Text>
      </View>

      <View style={[styles.statusPill, { backgroundColor: statusBg }]}>
        <Text style={styles.statusText}>{statusText}</Text>
      </View>

      <View style={styles.metrics}>
        <View style={styles.metricRow}>
          <Text style={styles.metricLabel}>오늘 사용</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={styles.metricValue}>
              {formatMinutes(todayUsed)}
              {dailyLimit > 0 ? ` / ${formatMinutes(dailyLimit)}` : "  (한도 없음)"}
            </Text>
            <Pressable onPress={resetUsage} disabled={!online} style={[styles.resetBtn, !online && { opacity: 0.4 }]}>
              <Text style={styles.resetBtnText}>리셋</Text>
            </Pressable>
          </View>
        </View>
        {dailyRemaining !== null && (
          <>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${dailyPct}%`,
                    backgroundColor:
                      dailyPct >= 100 ? "#ef4444" : dailyPct >= 80 ? "#f59e0b" : "#2563eb",
                  },
                ]}
              />
            </View>
            <Text style={styles.remainingLabel}>남은 한도 {formatMinutes(dailyRemaining)}</Text>
          </>
        )}
        {sessionRemainingSec > 0 && (
          <View style={[styles.metricRow, { marginTop: 8 }]}>
            <Text style={styles.metricLabel}>1회성 PIN 남은 시간</Text>
            <Text style={[styles.metricValue, { color: "#b45309" }]}>
              {formatDuration(sessionRemainingSec)}
            </Text>
          </View>
        )}
        {hasPausedSession && (
          <View style={[styles.metricRow, { marginTop: 8 }]}>
            <Text style={styles.metricLabel}>1회성 PIN (일시정지)</Text>
            <Text style={[styles.metricValue, { color: "#b45309" }]}>
              {formatDuration(pausedSec)} 남음
            </Text>
          </View>
        )}
      </View>

      <Pressable
        style={[
          styles.bigBtn,
          {
            backgroundColor: online
              ? (locked ? (hasPausedSession ? "#f59e0b" : "#10b981") : "#ef4444")
              : "#9ca3af",
          },
        ]}
        onPress={() => sendLock(locked ? "unlock" : "lock")}
        disabled={!online}
      >
        <Text style={styles.bigBtnText}>
          {!online
            ? "오프라인"
            : locked
              ? hasPausedSession
                ? `다시 열기 (${formatDuration(pausedSec)} 남음)`
                : "잠금 해제"
              : "즉시 잠금"}
        </Text>
      </Pressable>
      {!online && (
        <Text style={styles.offlineHint}>
          PC가 꺼져 있거나 인터넷에 연결되어 있지 않습니다. 온라인 상태가 되면 버튼이 활성화됩니다.
        </Text>
      )}

      {(sessionRemainingSec > 0 || hasPausedSession) && (
        <View style={styles.activeBlock}>
          <View style={styles.activeRow}>
            <Text style={styles.activeTitle}>
              현재 1회성 PIN {hasPausedSession ? "일시정지" : "사용 중"}
            </Text>
            <Pressable onPress={revokePin} style={styles.revokeBtn}>
              <Text style={styles.revokeBtnText}>취소</Text>
            </Pressable>
          </View>
          <Text style={styles.activeSub}>시간 변경</Text>
          <View style={styles.chipsRow}>
            {OTP_PRESETS.map((p) => (
              <Pressable
                key={p.minutes}
                onPress={() => adjustPin(p.minutes)}
                style={styles.chip}
              >
                <Text style={styles.chipText}>{p.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <View style={styles.otpBlock}>
        <Text style={styles.otpTitle}>1회성 PIN 발급</Text>

        <View style={styles.chipsRow}>
          {OTP_PRESETS.map((p) => (
            <Pressable
              key={p.minutes}
              onPress={() => setSelectedMinutes(p.minutes)}
              style={[
                styles.chip,
                selectedMinutes === p.minutes && styles.chipSelected,
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  selectedMinutes === p.minutes && styles.chipTextSelected,
                ]}
              >
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          style={[styles.issueBtnWide, otpBusy && { opacity: 0.5 }]}
          onPress={issueOtp}
          disabled={otpBusy}
        >
          <Text style={styles.issueBtnText}>
            {otpBusy
              ? "발급 중…"
              : issuedPin
                ? `재발급 (${selectedMinutes}분)`
                : `발급 (${selectedMinutes}분)`}
          </Text>
        </Pressable>

        {issuedPin && (
          <View style={styles.pinBox}>
            <Text style={styles.pinLabel}>PIN</Text>
            <Text style={styles.pinValue}>{issuedPin}</Text>
            <View style={styles.pinActions}>
              <Pressable style={styles.copyBtn} onPress={copyPin}>
                <Text style={styles.copyBtnText}>
                  {copied ? "✓ 복사됨" : "복사"}
                </Text>
              </Pressable>
              <Pressable
                style={styles.clearBtn}
                onPress={() => {
                  setIssuedPin(null);
                  setCopied(false);
                }}
              >
                <Text style={styles.clearBtnText}>지우기</Text>
              </Pressable>
            </View>
          </View>
        )}

        {history.length > 0 && (
          <View style={styles.historyBlock}>
            <Text style={styles.historyTitle}>최근 발급 기록</Text>
            {history.map((h) => (
              <View key={h.id} style={styles.historyRow}>
                <Text style={styles.historyTime}>{formatTime(h.issuedAt)}</Text>
                <Text style={styles.historyMins}>{h.minutes}분</Text>
                <Text style={styles.historyStatus}>
                  {h.consumed ? "사용됨" : "대기"}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <View style={styles.links}>
        <Pressable
          style={styles.linkBtn}
          onPress={() => navigation.navigate("Schedule", { deviceId })}
        >
          <Text style={styles.linkBtnText}>스케줄 설정</Text>
        </Pressable>
        <Pressable
          style={styles.linkBtn}
          onPress={() => navigation.navigate("Usage", { deviceId })}
        >
          <Text style={styles.linkBtnText}>사용 시간</Text>
        </Pressable>
      </View>
    </View>
  );
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatMinutes(mins: number): string {
  const m = Math.max(0, Math.floor(mins));
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}시간` : `${h}시간 ${r}분`;
}

function formatTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

const styles = StyleSheet.create({
  root: { padding: 16, paddingBottom: 48 },
  empty: { padding: 24, textAlign: "center", color: "#666" },

  card: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  deviceName: { fontSize: 20, fontWeight: "700", flex: 1 },
  dot: { fontSize: 12, fontWeight: "600" },

  statusPill: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    marginBottom: 12,
  },
  statusText: { fontSize: 16, fontWeight: "700", color: "#111", flexShrink: 1 },

  metrics: {
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  metricRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginVertical: 2,
  },
  metricLabel: { fontSize: 13, color: "#6b7280" },
  metricValue: { fontSize: 14, color: "#111", fontWeight: "600" },
  progressTrack: {
    height: 6,
    backgroundColor: "#e5e7eb",
    borderRadius: 3,
    marginTop: 6,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 3 },
  remainingLabel: {
    fontSize: 12,
    color: "#6b7280",
    marginTop: 4,
    textAlign: "right",
  },
  resetBtn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#d1d5db",
    backgroundColor: "#fff",
  },
  resetBtnText: { fontSize: 12, color: "#6b7280", fontWeight: "600" },

  activeBlock: {
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#fef3c7",
    borderWidth: 1,
    borderColor: "#fcd34d",
  },
  activeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  activeTitle: { fontSize: 14, fontWeight: "700", color: "#78350f" },
  activeSub: { fontSize: 12, color: "#78350f", marginBottom: 6 },
  revokeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: "#dc2626",
  },
  revokeBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },

  bigBtn: { paddingVertical: 18, borderRadius: 12, alignItems: "center" },
  bigBtnText: { color: "#fff", fontSize: 20, fontWeight: "700" },
  offlineHint: { marginTop: 8, fontSize: 12, color: "#6b7280", textAlign: "center" },

  otpBlock: {
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#f3f4f6",
  },
  otpTitle: { fontSize: 14, fontWeight: "700", marginBottom: 10 },

  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#d1d5db",
    backgroundColor: "#fff",
  },
  chipSelected: { borderColor: "#2563eb", backgroundColor: "#2563eb" },
  chipText: { color: "#374151", fontWeight: "600" },
  chipTextSelected: { color: "#fff" },

  issueBtnWide: {
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: "#2563eb",
    alignItems: "center",
  },
  issueBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },

  pinBox: {
    marginTop: 12,
    padding: 16,
    borderRadius: 10,
    backgroundColor: "#1e3a8a",
    alignItems: "center",
  },
  pinLabel: { fontSize: 11, color: "#dbeafe", letterSpacing: 1, marginBottom: 4 },
  pinValue: {
    fontSize: 44,
    fontWeight: "700",
    letterSpacing: 8,
    color: "#fff",
    fontVariantNumeric: "tabular-nums" as any,
  },
  pinActions: { flexDirection: "row", gap: 10, marginTop: 12 },
  copyBtn: {
    paddingVertical: 8,
    paddingHorizontal: 22,
    borderRadius: 8,
    backgroundColor: "#fff",
  },
  copyBtnText: { color: "#1e3a8a", fontWeight: "700" },
  clearBtn: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#93c5fd",
  },
  clearBtnText: { color: "#dbeafe", fontWeight: "600" },

  historyBlock: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#e5e7eb" },
  historyTitle: { fontSize: 13, fontWeight: "700", color: "#374151", marginBottom: 6 },
  historyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  historyTime: { fontSize: 13, color: "#374151", flex: 1 },
  historyMins: { fontSize: 13, color: "#111", fontWeight: "600", width: 60, textAlign: "right" },
  historyStatus: { fontSize: 12, color: "#6b7280", width: 60, textAlign: "right" },

  links: { flexDirection: "row", gap: 8, marginTop: 14 },
  linkBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: "#eef2ff",
    alignItems: "center",
  },
  linkBtnText: { color: "#2563eb", fontWeight: "600" },

  addBtn: {
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: "#2563eb",
    alignItems: "center",
  },
  addBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
