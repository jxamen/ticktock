import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { claimPairingCode } from "../firebase";
import type { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Pairing">;

export function PairingScreen({ navigation }: Props) {
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (code.length !== 6) {
      Alert.alert("코드 확인", "6자리 숫자 코드를 입력하세요.");
      return;
    }
    setBusy(true);
    try {
      await claimPairingCode(code, { deviceName: deviceName.trim() || undefined });
      navigation.replace("Devices");
    } catch (e: any) {
      Alert.alert("페어링 실패", translateError(e.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <Text style={styles.title}>PC 연결</Text>
      <Text style={styles.subtitle}>
        자녀 PC의 TickTock 화면에 표시된 6자리 코드를 입력하세요.
      </Text>

      <Text style={styles.label}>페어링 코드</Text>
      <TextInput
        style={styles.codeInput}
        value={code}
        onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
        keyboardType="number-pad"
        maxLength={6}
        autoFocus
        placeholder="123456"
      />

      <Text style={styles.label}>디바이스 이름 (선택)</Text>
      <TextInput
        style={styles.nameInput}
        value={deviceName}
        onChangeText={setDeviceName}
        placeholder="거실 PC"
        maxLength={40}
      />

      <Pressable
        style={[styles.submit, (busy || code.length !== 6) && { opacity: 0.5 }]}
        onPress={submit}
        disabled={busy || code.length !== 6}
      >
        <Text style={styles.submitText}>{busy ? "연결 중…" : "연결하기"}</Text>
      </Pressable>
    </View>
  );
}

function translateError(msg: string): string {
  if (msg.includes("expired")) return "코드가 만료되었습니다. PC에서 새 코드를 확인하세요.";
  if (msg.includes("already claimed")) return "이미 연결된 코드입니다.";
  if (msg.includes("unknown code")) return "잘못된 코드입니다.";
  return msg;
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24 },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 8 },
  subtitle: { fontSize: 14, color: "#555", marginBottom: 24, lineHeight: 20 },
  label: { fontSize: 13, color: "#374151", marginTop: 16, marginBottom: 6 },
  codeInput: {
    fontSize: 36,
    letterSpacing: 8,
    textAlign: "center",
    padding: 16,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#2563eb",
    backgroundColor: "#fff",
    fontVariantNumeric: "tabular-nums" as any,
  },
  nameInput: {
    fontSize: 16,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#d1d5db",
    backgroundColor: "#fff",
  },
  submit: {
    marginTop: 32,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: "#2563eb",
    alignItems: "center",
  },
  submitText: { color: "white", fontSize: 18, fontWeight: "700" },
});
