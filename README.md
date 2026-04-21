# TickTock

Remote PC usage control for kids. Windows agent (Rust + Tauri) + mobile app (React Native) + Firebase realtime relay.

See [CLAUDE.md](./CLAUDE.md) for architecture, security model, and conventions.

## Packages

| Path | What | Stack |
|---|---|---|
| `agent/` | Windows PC agent (runs as Windows Service) | Rust + Tauri 2 + React |
| `mobile/` | Parent remote control app | React Native + Expo |
| `shared/` | Shared TS types (RTDB schema, commands) | TypeScript |
| `docs/` | Setup guides | Markdown |

## Quick start

```bash
npm install                 # installs all workspaces

# agent (Windows, Rust toolchain + WebView2 required)
cd agent && npm run tauri dev

# mobile
cd mobile && npx expo start
```

Firebase project setup: see [docs/firebase-setup.md](./docs/firebase-setup.md).

## Security model

Short version: **no Windows password**. Windows auto-logs in, and the TickTock overlay is the only gate. Unlock paths:
1. Parent app (one-tap, via Firebase command)
2. On-PC PIN (offline fallback, stored via DPAPI)

Full rationale in [CLAUDE.md](./CLAUDE.md).
