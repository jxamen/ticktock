import { getCurrentWindow } from "@tauri-apps/api/window";
import { Overlay } from "./overlay/Overlay";
import { Tray } from "./tray/Tray";
import { Timer } from "./timer/Timer";

// The same React bundle is loaded by every Tauri window; Rust decides which
// window to open and we branch on the window label here.
//   - "overlay": full-screen lock UI (PIN entry / first-run setup)
//   - "tray":    status window opened from the system tray
//   - "timer":   bottom-right countdown while a one-time-PIN session is active
export function App() {
  const label = getCurrentWindow().label;

  if (label === "overlay") return <Overlay />;
  if (label === "tray") return <Tray />;
  if (label === "timer") return <Timer />;

  return <div>Unknown window: {label}</div>;
}
