import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { subscribeToDailyUsage } from "../firebase";
import type { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Usage">;

const DAY_WINDOW = 7;

export function UsageScreen({ route }: Props) {
  const { deviceId } = route.params;

  const days = useMemo(() => buildRecentDays(DAY_WINDOW), []);
  const [selectedYmd, setSelectedYmd] = useState<string>(days[0].ymd);
  const [usage, setUsage] = useState<Record<string, number>>({});

  useEffect(
    () => subscribeToDailyUsage(deviceId, selectedYmd, setUsage),
    [deviceId, selectedYmd],
  );

  const entries = Object.entries(usage).sort((a, b) => b[1] - a[1]);
  const totalSeconds = entries.reduce((sum, [, s]) => sum + s, 0);
  const maxSeconds = entries[0]?.[1] ?? 0;

  return (
    <View style={styles.root}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.dayRow}
      >
        {days.map((d) => {
          const on = d.ymd === selectedYmd;
          return (
            <Pressable
              key={d.ymd}
              onPress={() => setSelectedYmd(d.ymd)}
              style={[styles.dayChip, on && styles.dayChipOn]}
            >
              <Text style={[styles.dayLabel, on && styles.dayLabelOn]}>{d.label}</Text>
              <Text style={[styles.daySub, on && styles.daySubOn]}>{d.dateShort}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.summary}>
        <Text style={styles.summaryLabel}>총 사용</Text>
        <Text style={styles.summaryValue}>{formatDuration(totalSeconds)}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {entries.length === 0 ? (
          <Text style={styles.empty}>이 날짜에 기록된 사용 시간이 없습니다.</Text>
        ) : (
          entries.map(([name, seconds]) => (
            <View key={name} style={styles.row}>
              <View style={styles.rowHead}>
                <Text style={styles.procName} numberOfLines={1}>{friendlyName(name)}</Text>
                <Text style={styles.procSecs}>{formatDuration(seconds)}</Text>
              </View>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.barFill,
                    { width: `${maxSeconds > 0 ? (seconds / maxSeconds) * 100 : 0}%` },
                  ]}
                />
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function buildRecentDays(n: number) {
  const out: { ymd: string; label: string; dateShort: string }[] = [];
  const today = new Date();
  const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push({
      ymd: ymd(d),
      label: i === 0 ? "오늘" : i === 1 ? "어제" : dayNames[d.getDay()],
      dateShort: `${d.getMonth() + 1}/${d.getDate()}`,
    });
  }
  return out;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${sec}초`;
  return `${sec}초`;
}

function friendlyName(process: string): string {
  return process.replace(/\.exe$/i, "");
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f9fafb" },

  dayRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  dayChip: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    alignItems: "center",
    minWidth: 64,
  },
  dayChipOn: { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  dayLabel: { fontSize: 14, fontWeight: "700", color: "#111" },
  dayLabelOn: { color: "#fff" },
  daySub: { fontSize: 11, color: "#6b7280", marginTop: 2 },
  daySubOn: { color: "#dbeafe" },

  summary: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    padding: 16,
    borderRadius: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  summaryLabel: { fontSize: 14, color: "#6b7280" },
  summaryValue: { fontSize: 24, fontWeight: "700", color: "#111" },

  list: { padding: 16, paddingBottom: 48 },
  empty: { textAlign: "center", padding: 32, color: "#6b7280" },

  row: { marginBottom: 14 },
  rowHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  procName: { flex: 1, fontSize: 14, color: "#111", fontWeight: "600" },
  procSecs: { fontSize: 13, color: "#374151", marginLeft: 8, fontVariantNumeric: "tabular-nums" as any },
  barTrack: {
    height: 6,
    backgroundColor: "#e5e7eb",
    borderRadius: 3,
    overflow: "hidden",
  },
  barFill: { height: "100%", backgroundColor: "#2563eb", borderRadius: 3 },
});
