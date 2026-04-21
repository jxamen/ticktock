import type { DeviceId } from "@ticktock/shared";

export type RootStackParamList = {
  Login: undefined;
  Devices: undefined;
  Pairing: undefined;
  Control: { deviceId: DeviceId };
  Schedule: { deviceId: DeviceId };
  Usage: { deviceId: DeviceId };
};
