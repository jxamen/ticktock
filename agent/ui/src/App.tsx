import { getCurrentWindow } from "@tauri-apps/api/window";
import { AdminSetup } from "./admin/AdminSetup";
import { Overlay } from "./overlay/Overlay";
import { Timer } from "./timer/Timer";

// Same React bundle is loaded by every Tauri window; Rust decides which window
// to open and we branch on the window label here. The tray window was removed
// in v0.1.x — parents control the device through the mobile app, so a local
// tray UI would be an attack surface that lets the child self-grant time.
//   - "overlay": full-screen lock UI (PIN entry / first-run setup)
//   - "timer":   bottom-right countdown
//   - "admin":   parent (Windows administrator) setup console
export function App() {
  const label = getCurrentWindow().label;

  if (label === "overlay") return <Overlay />;
  if (label === "timer") return <Timer />;
  if (label === "admin") return <AdminSetup />;

  return <div>Unknown window: {label}</div>;
}
