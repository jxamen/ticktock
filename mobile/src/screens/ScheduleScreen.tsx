import { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  TextInput,
  Alert,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { saveSchedule, subscribeToSchedule } from "../firebase";
import type { Schedule, AllowedRange, Weekday } from "@ticktock/shared";
import type { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Schedule">;

// Default when nothing is set yet: no time-of-day restriction, no daily cap.
// Parent explicitly adds rules to enable enforcement — matches the agent
// convention in schedule.rs::evaluate.
const EMPTY: Schedule = { allowedRanges: [], dailyLimitMinutes: 0, perAppLimits: {} };

const WEEKDAYS: { num: Weekday; label: string }[] = [
  { num: 1, label: "월" },
  { num: 2, label: "화" },
  { num: 3, label: "수" },
  { num: 4, label: "목" },
  { num: 5, label: "금" },
  { num: 6, label: "토" },
  { num: 7, label: "일" },
];

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function ScheduleScreen({ route }: Props) {
  const { deviceId } = route.params;
  const [schedule, setSchedule] = useState<Schedule>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(
    () =>
      subscribeToSchedule(deviceId, (s) =>
        // RTDB omits empty fields; normalize so .map() / Object.entries() are safe.
        setSchedule({
          allowedRanges: s?.allowedRanges ?? [],
          dailyLimitMinutes: s?.dailyLimitMinutes ?? 0,
          perAppLimits: s?.perAppLimits ?? {},
        }),
      ),
    [deviceId],
  );

  const updateDaily = (raw: string) => {
    const n = parseInt(raw.replace(/\D/g, ""), 10);
    setSchedule({ ...schedule, dailyLimitMinutes: Number.isFinite(n) ? n : 0 });
  };

  const addRange = () =>
    setSchedule({
      ...schedule,
      allowedRanges: [
        ...schedule.allowedRanges,
        { days: [1, 2, 3, 4, 5], start: "16:00", end: "20:00" },
      ],
    });

  const removeRange = (i: number) =>
    setSchedule({
      ...schedule,
      allowedRanges: schedule.allowedRanges.filter((_, idx) => idx !== i),
    });

  const updateRange = (i: number, patch: Partial<AllowedRange>) => {
    const next = schedule.allowedRanges.slice();
    next[i] = { ...next[i], ...patch };
    setSchedule({ ...schedule, allowedRanges: next });
  };

  const toggleDay = (i: number, day: Weekday) => {
    const r = schedule.allowedRanges[i];
    const has = r.days.includes(day);
    const nextDays = has ? r.days.filter((d) => d !== day) : [...r.days, day].sort();
    updateRange(i, { days: nextDays });
  };

  const validate = (): string | null => {
    for (const r of schedule.allowedRanges) {
      if (r.days.length === 0) return "요일이 선택되지 않은 구간이 있습니다.";
      if (!HHMM.test(r.start) || !HHMM.test(r.end)) return "시간 형식은 HH:MM 이어야 합니다 (예: 16:00).";
      if (r.start >= r.end) return "종료 시간이 시작 시간보다 늦어야 합니다.";
    }
    if (schedule.dailyLimitMinutes < 0) return "일일 한도는 0 이상이어야 합니다.";
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) {
      Alert.alert("입력 확인", err);
      return;
    }
    setSaving(true);
    try {
      await saveSchedule(deviceId, schedule);
      Alert.alert("저장됨", "스케줄이 PC에 적용되었습니다.");
    } catch (e) {
      Alert.alert("저장 실패", String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.sectionTitle}>일일 한도</Text>
      <Text style={styles.hint}>하루 총 사용 가능 시간. 0이면 무제한.</Text>
      <View style={styles.inlineRow}>
        <TextInput
          style={styles.numInput}
          keyboardType="number-pad"
          value={String(schedule.dailyLimitMinutes)}
          onChangeText={updateDaily}
        />
        <Text style={styles.inlineLabel}>
          분 {schedule.dailyLimitMinutes === 0 ? "(무제한)" : `(≈ ${(schedule.dailyLimitMinutes / 60).toFixed(1)}시간)`}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>허용 시간대</Text>
      <Text style={styles.hint}>
        하나라도 추가되어 있으면 이 시간대 밖에서 자동 잠금됩니다. 비워 두면 시간 제한 없음.
      </Text>

      {schedule.allowedRanges.map((r, i) => (
        <View key={i} style={styles.rangeCard}>
          <View style={styles.rangeHeader}>
            <Text style={styles.rangeTitle}>구간 {i + 1}</Text>
            <Pressable onPress={() => removeRange(i)} style={styles.removeBtn}>
              <Text style={styles.removeBtnText}>삭제</Text>
            </Pressable>
          </View>

          <Text style={styles.smallLabel}>요일</Text>
          <View style={styles.daysRow}>
            {WEEKDAYS.map((d) => {
              const on = r.days.includes(d.num);
              return (
                <Pressable
                  key={d.num}
                  onPress={() => toggleDay(i, d.num)}
                  style={[styles.dayChip, on && styles.dayChipOn]}
                >
                  <Text style={[styles.dayChipText, on && styles.dayChipTextOn]}>{d.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.timeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.smallLabel}>시작</Text>
              <TextInput
                style={styles.timeInput}
                value={r.start}
                placeholder="HH:MM"
                autoCapitalize="none"
                maxLength={5}
                onChangeText={(v) => updateRange(i, { start: v })}
              />
            </View>
            <View style={styles.timeSep} />
            <View style={{ flex: 1 }}>
              <Text style={styles.smallLabel}>종료</Text>
              <TextInput
                style={styles.timeInput}
                value={r.end}
                placeholder="HH:MM"
                autoCapitalize="none"
                maxLength={5}
                onChangeText={(v) => updateRange(i, { end: v })}
              />
            </View>
          </View>
        </View>
      ))}

      <Pressable style={styles.addBtn} onPress={addRange}>
        <Text style={styles.addBtnText}>+ 시간대 추가</Text>
      </Pressable>

      <Text style={styles.sectionTitle}>앱별 한도</Text>
      <Text style={styles.hint}>
        사용 시간 화면에서 앱을 선택해 제한할 수 있습니다 (곧 추가 예정).
      </Text>

      <Pressable style={[styles.saveBtn, saving && { opacity: 0.5 }]} onPress={save} disabled={saving}>
        <Text style={styles.saveBtnText}>{saving ? "저장 중…" : "저장하기"}</Text>
      </Pressable>

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, paddingBottom: 48 },

  sectionTitle: { fontSize: 18, fontWeight: "700", marginTop: 24, marginBottom: 4 },
  hint: { color: "#6b7280", fontSize: 13, marginBottom: 10, lineHeight: 18 },

  inlineRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  numInput: {
    width: 100,
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
    backgroundColor: "#fff",
  },
  inlineLabel: { fontSize: 14, color: "#374151" },

  rangeCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  rangeHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  rangeTitle: { fontSize: 15, fontWeight: "700", color: "#111" },
  removeBtn: { paddingVertical: 4, paddingHorizontal: 10 },
  removeBtnText: { color: "#ef4444", fontWeight: "600" },

  smallLabel: { fontSize: 12, color: "#374151", marginBottom: 6, marginTop: 4 },

  daysRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 4 },
  dayChip: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#d1d5db",
    backgroundColor: "#fff",
  },
  dayChipOn: { borderColor: "#2563eb", backgroundColor: "#2563eb" },
  dayChipText: { color: "#374151", fontWeight: "600" },
  dayChipTextOn: { color: "#fff" },

  timeRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 6 },
  timeSep: { width: 12 },
  timeInput: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
    backgroundColor: "#fff",
    fontVariantNumeric: "tabular-nums" as any,
  },

  addBtn: {
    padding: 14,
    backgroundColor: "#eef2ff",
    borderRadius: 10,
    alignItems: "center",
    marginTop: 4,
  },
  addBtnText: { color: "#2563eb", fontWeight: "700" },

  saveBtn: {
    marginTop: 28,
    padding: 16,
    backgroundColor: "#2563eb",
    borderRadius: 10,
    alignItems: "center",
  },
  saveBtnText: { color: "white", fontWeight: "700", fontSize: 16 },
});
