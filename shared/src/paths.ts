// RTDB path helpers — single source of truth for node locations.

import type { DeviceId, UserId } from "./types";

export const paths = {
  userDevices: (uid: UserId) => `/users/${uid}/devices`,
  userDeviceRole: (uid: UserId, deviceId: DeviceId) => `/users/${uid}/devices/${deviceId}`,

  device: (deviceId: DeviceId) => `/devices/${deviceId}`,
  deviceMeta: (deviceId: DeviceId) => `/devices/${deviceId}/meta`,
  deviceState: (deviceId: DeviceId) => `/devices/${deviceId}/state`,
  deviceSchedule: (deviceId: DeviceId) => `/devices/${deviceId}/schedule`,

  deviceCommands: (deviceId: DeviceId) => `/devices/${deviceId}/commands`,
  deviceCommand: (deviceId: DeviceId, commandId: string) => `/devices/${deviceId}/commands/${commandId}`,

  deviceUsage: (deviceId: DeviceId) => `/devices/${deviceId}/usage`,
  deviceUsageDay: (deviceId: DeviceId, dateYmd: string) => `/devices/${deviceId}/usage/${dateYmd}`,
} as const;
