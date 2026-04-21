import { initializeApp } from "firebase/app";
// Firebase JS SDK doesn't auto-register Auth in React Native: we must call
// initializeAuth() with ReactNativeAsyncStorage so state persists across
// restarts.
import { initializeAuth, getReactNativePersistence } from "firebase/auth";
import { getDatabase, ref, set, push, serverTimestamp, onValue } from "firebase/database";
import ReactNativeAsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import type { Command, CommandType, DeviceId, Schedule } from "@ticktock/shared";
import { paths } from "@ticktock/shared";

const config = (Constants.expoConfig?.extra?.firebase ?? {}) as Record<string, string>;
const FUNCTIONS_BASE = (Constants.expoConfig?.extra?.functionsBaseUrl ?? "") as string;

export const app = initializeApp(config);
export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(ReactNativeAsyncStorage),
});
export const db = getDatabase(app);

export function issueCommand<T extends Command>(
  deviceId: DeviceId,
  type: CommandType,
  payload: T["payload"],
  issuedBy: string,
) {
  const commandsRef = ref(db, paths.deviceCommands(deviceId));
  const newRef = push(commandsRef);
  return set(newRef, {
    type,
    payload,
    issuedAt: serverTimestamp(),
    issuedBy,
    consumed: false,
    consumedAt: null,
  });
}

// Generate a random 4-digit PIN locally (not on the device) and issue it as a
// one-time PIN command. The plaintext is only sent through RTDB inside the
// command payload — the agent hashes it on receipt. Returns the plaintext so
// the UI can show it to the parent for delivery to the child.
export async function issueOneTimePin(
  deviceId: DeviceId,
  minutes: number,
  issuedBy: string,
): Promise<string> {
  const pin = Math.floor(1000 + Math.random() * 9000).toString();
  await issueCommand(deviceId, "issueOneTimePin", { pin, minutes }, issuedBy);
  return pin;
}

// Pair an agent by claiming the 6-digit code it displayed. Returns the new
// deviceId — which shortly after appears under /users/{uid}/devices via the
// Cloud Function's write, so DevicesScreen's subscription picks it up.
export async function claimPairingCode(
  code: string,
  opts?: { deviceName?: string; timezone?: string },
): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("로그인이 필요합니다.");
  const idToken = await user.getIdToken();
  const resp = await fetch(`${FUNCTIONS_BASE}/claimPairingCode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      code,
      deviceName: opts?.deviceName,
      timezone: opts?.timezone,
    }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.deviceId as string;
}

export function subscribeToState(
  deviceId: DeviceId,
  cb: (state: unknown) => void,
) {
  return onValue(ref(db, paths.deviceState(deviceId)), (snap) => cb(snap.val()));
}

export function subscribeToSchedule(
  deviceId: DeviceId,
  cb: (schedule: Schedule | null) => void,
) {
  return onValue(ref(db, paths.deviceSchedule(deviceId)), (snap) =>
    cb((snap.val() ?? null) as Schedule | null),
  );
}

// { processName: seconds } — empty object when no usage yet for that date.
export function subscribeToDailyUsage(
  deviceId: DeviceId,
  dateYmd: string,
  cb: (totals: Record<string, number>) => void,
) {
  return onValue(ref(db, paths.deviceUsageDay(deviceId, dateYmd)), (snap) =>
    cb((snap.val() ?? {}) as Record<string, number>),
  );
}

// Owner-write is allowed by the security rules, so we write the full Schedule
// node directly instead of going through the command pipeline. The agent's
// SSE listener picks it up automatically.
export function saveSchedule(deviceId: DeviceId, schedule: Schedule) {
  return set(ref(db, paths.deviceSchedule(deviceId)), schedule);
}
