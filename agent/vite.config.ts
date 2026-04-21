import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port; see https://tauri.app/v2/guide/
export default defineConfig({
  plugins: [react()],
  root: "ui",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "esnext",
  },
});
