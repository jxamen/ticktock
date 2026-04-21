import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, TextInput } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { auth, issueCommand, issueOneTimePin, subscribeToState } from "../firebase";
import type { RootStackParamList } from "../navigation";
import type { DeviceState } from "@ticktock/shared";

type Props = NativeStackScreenProps<RootStackParamList, "Control">;

export function ControlScreen({ route }: Props) {
  const { deviceId } = route.params;
  const [state, setState] = useState<DeviceState | null>(null);
  const [otpMinutes, setOtpMinutes] = useState("30");
  const [issuedPin, setIssuedPin] = useState<string | null>(null);
  const [otpBusy, setOtpBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => subscribeToState(deviceId, (v) => setState(v as DeviceState | null)), [deviceId]);

  const send = async (type: "lock" | "unlock") => {
    try {
      const uid = auth.currentUser?.uid ?? "anonymous";
      await issueCommand(deviceId, type, {}, uid);
    } catch (e) {
      Alert.alert("전송 실패", String(e));
    }
  };

  const issueOtp = async () => {
    const minutes = parseInt(otpMinutes, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      Alert.alert("잘못된 시간", "분은 1 이상 숫자여야 합니다.");
      return;
    }
    setOtpBusy(true);
    setCopied(false);
    try {
      const uid = auth.currentUser?.uid ?? "anonymous";
      const pin = await issueOneTimePin(deviceId, minutes, uid);
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

  const locked = state?.locked ?? true;
  const onlineMs = Date.now() - (state?.lastHeartbeat ?? 0);
  const online = onlineMs < 60_000;

  return (
    <View style={styles.root}>
      <View style={[styles.card, { backgroundColor: locked ? "#fee2e2" : "#d1fae5" }]}>
        <Text style={styles.status}>{locked ? "잠금" : "사용 중"}</Text>
        <Text style={styles.sub}>{online ? "● 온라인" : "○ 오프라인"}</Text>
        <Text style={styles.sub}>오늘 사용: {state?.todayUsedMinutes ?? 0}분</Text>
      </View>

      <Pressable style={[styles.big, { backgroundColor: locked ? "#10b981" : "#ef4444" }]} onPress={() => send(locked ? "unlock" : "lock")}>
        <Text style={styles.bigText}>{locked ? "잠금 해제" : "즉시 잠금"}</Text>
      </Pressable>

      <View style={styles.otpSection}>
        <Text style={styles.sectionTitle}>1회성 PIN 발급</Text>
        <Text style={styles.sectionSub}>
          자녀가 PC에서 입력한 시점부터 지정한 분만큼 해제됩니다.
        </Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.minutesInput}
            keyboardType="number-pad"
            value={otpMinutes}
            onChangeText={setOtpMinutes}
          />
          <Text style={styles.minutesLabel}>분</Text>
          <Pressable
            style={[styles.issueBtn, otpBusy && { opacity: 0.5 }]}
            onPress={issueOtp}
            disabled={otpBusy}
          >
            <Text style={styles.issueBtnText}>{otpBusy ? "발급 중…" : (issuedPin ? "재발급" : "발급")}</Text>
          </Pressable>
        </View>

        {issuedPin && (
          <View style={styles.pinBox}>
            <Text style={styles.pinLabel}>1회성 PIN</Text>
            <Text style={styles.pinValue}>{issuedPin}</Text>
            <View style={styles.pinActions}>
              <Pressable style={styles.copyBtn} onPress={copyPin}>
                <Text style={styles.copyBtnText}>{copied ? "✓ 복사됨" : "복사"}</Text>
              </Pressable>
              <Pressable style={styles.clearBtn} onPress={() => { setIssuedPin(null); setCopied(false); }}>
                <Text style={styles.clearBtnText}>지우기</Text>
              </Pressable>
            </View>
            <Text style={styles.pinHint}>자녀에게 전달 후 PC 오버레이 우하단 코너 3회 클릭 → PIN 입력</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24 },
  card: { padding: 20, borderRadius: 12, marginBottom: 24 },
  status: { fontSize: 32, fontWeight: "700", marginBottom: 4 },
  sub: { fontSize: 14, color: "#333", marginTop: 4 },
  big: { paddingVertical: 32, borderRadius: 16, alignItems: "center" },
  bigText: { color: "white", fontSize: 28, fontWeight: "700" },
  otpSection: { marginTop: 32, padding: 16, borderRadius: 12, backgroundColor: "#f3f4f6" },
  sectionTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  sectionSub: { fontSize: 12, color: "#555", marginBottom: 12 },
  inputRow: { flexDirection: "row", alignItems: "center" },
  minutesInput: { width: 80, padding: 8, borderRadius: 6, borderWidth: 1, borderColor: "#d1d5db", fontSize: 16, backgroundColor: "#fff" },
  minutesLabel: { fontSize: 16, marginLeft: 8, marginRight: "auto" },
  issueBtn: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 6, backgroundColor: "#2563eb" },
  issueBtnText: { color: "white", fontWeight: "600" },
  pinBox: { marginTop: 16, padding: 20, borderRadius: 12, backgroundColor: "#1e3a8a", alignItems: "center" },
  pinLabel: { fontSize: 12, color: "#dbeafe", marginBottom: 6, letterSpacing: 1 },
  pinValue: { fontSize: 48, fontWeight: "700", letterSpacing: 8, color: "#fff", fontVariantNumeric: "tabular-nums" as any },
  pinActions: { flexDirection: "row", gap: 10, marginTop: 14 },
  copyBtn: { paddingVertical: 10, paddingHorizontal: 24, borderRadius: 8, backgroundColor: "#fff" },
  copyBtnText: { color: "#1e3a8a", fontWeight: "700", fontSize: 15 },
  clearBtn: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8, borderWidth: 1, borderColor: "#93c5fd" },
  clearBtnText: { color: "#dbeafe", fontWeight: "600", fontSize: 15 },
  pinHint: { marginTop: 12, fontSize: 11, color: "#bfdbfe", textAlign: "center" },
});
