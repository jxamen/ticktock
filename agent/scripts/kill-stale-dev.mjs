// Kill leftover dev processes before `tauri dev` so Vite's port (1420) and the
// previous agent binary don't block the next run. Safe to call repeatedly —
// each step is best-effort and silent when nothing matches.

import { execSync } from "node:child_process";
import process from "node:process";

const PORT = 1420;
const AGENT_IMAGES = ["ticktock-agent.exe", "TickTock.exe"];

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function killPortWindows(port) {
  const out = run(`netstat -ano -p TCP`);
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [, local, , state, pid] = parts;
    if (state !== "LISTENING") continue;
    if (!local?.endsWith(`:${port}`)) continue;
    if (pid && pid !== "0") pids.add(pid);
  }
  for (const pid of pids) {
    run(`taskkill /PID ${pid} /F`);
    console.log(`[kill-stale-dev] freed port ${port} (pid ${pid})`);
  }
}

function killPortUnix(port) {
  run(`fuser -k ${port}/tcp`);
}

function killByNameWindows(images) {
  for (const image of images) {
    const out = run(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`);
    if (out.toLowerCase().includes(image.toLowerCase())) {
      run(`taskkill /IM ${image} /F`);
      console.log(`[kill-stale-dev] killed ${image}`);
    }
  }
}

if (process.platform === "win32") {
  killPortWindows(PORT);
  killByNameWindows(AGENT_IMAGES);
} else {
  killPortUnix(PORT);
}
