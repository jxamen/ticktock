# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

나를 "태훈님"으로 불러줘.
모든 내용은 "한글"로 답변해줘.

## Project: TickTock

부모가 자녀의 Windows PC 사용을 **원격(외부 네트워크 포함)** 및 **로컬**에서 제어하는 시스템. Firebase Realtime Database를 릴레이로 사용해 NAT/방화벽 뒤의 PC를 제어하고, 사용자별·앱별 사용 시간을 추적한다.

- `agent/` — Windows PC 에이전트 (Rust + Tauri 2, Windows Service로 설치)
- `mobile/` — 부모용 원격 제어 앱 (React Native + Expo)
- `shared/` — 공용 TypeScript 타입 및 RTDB 스키마
- `docs/` — Firebase 설정, 페어링, 배포 가이드

## Core security model

**Windows 로그인 암호를 사용하지 않는다.** Windows는 자동 로그인으로 설정되고, 유일한 방어선은 TickTock 에이전트의 하드 잠금 오버레이이다.

- 부팅 → 자동 로그인 → 서비스 시작 → **오버레이 즉시 ON (fail-closed)**
- 부모 앱 또는 PC의 PIN 입력으로만 해제
- 오버레이 = Tauri 전체화면 창 (topmost, 포커스 고정, 시스템 키 조합 차단)
- 서비스가 중지되면 오버레이가 사라질 수 있으므로 Service Recovery 옵션으로 즉시 자동 재시작

이 모델에서 **Windows 자격 증명은 저장·전송·입력될 일이 없다.** 이는 의도적인 설계 결정이다.

## Architecture

```
 [RN 부모 앱]  ──write command──►  [Firebase RTDB]  ──SSE stream──►  [Windows 에이전트]
      ▲                             /devices/{id}                         │
      └────── state/heartbeat ◄──── /state ◄────── write ──────────────────┘
                                                                          │
                                                          [Local SQLite: usage/sessions]
                                                                          │
                                                                          ▼
                                                   5분마다 /usage/{date} 집계 push
```

### 통신 모델
- **Command 채널** (`/devices/{id}/commands/{cid}`): 부모 앱이 쓰기 → 에이전트 소비 후 `consumed: true` 업데이트. 타입: `lock`, `unlock`, `setSchedule`, `setAppLimit`, `grantBonus`.
- **State 채널** (`/devices/{id}/state`): 에이전트가 30초 heartbeat + 상태 변경 즉시 push.
- **Usage 채널** (`/devices/{id}/usage/{YYYY-MM-DD}/{processName}`): 5분마다 하루 누적 초 단위 집계 push. 세션 raw 데이터는 로컬에만.
- **오프라인 복원**: 에이전트 재연결 시 `consumed: false` 명령을 `issuedAt` 오름차순으로 모두 처리.

### 잠금 해제 경로
1. **부모 앱** (기본): Firebase command → 에이전트가 오버레이 OFF.
2. **PC의 PIN** (오프라인 폴백): 오버레이에 숨겨진 입력 트리거(Ctrl+Alt+P 또는 특정 코너 3회 클릭) → 4~6자리 PIN → 에이전트가 오버레이 OFF. 오답 5회 시 10분 입력 잠금. PIN은 OS Credential Manager(DPAPI)에 해시로 저장.
3. **관리자 복구** (최후의 수단): Windows 안전모드 또는 서비스 중지는 OS 관리자 권한 필요 → 부모만 가능.

### 스케줄 엔진
- 1분 tick마다 (시각, 요일, timezone)과 `allowedRanges` 대조.
- 전역 `dailyLimitMinutes` + 앱별 `perAppLimits[processName] = minutes` 동시 평가.
- 상태 전환 edge에서만 lock/unlock 호출 → UI 깜빡임 방지.
- 자정 지역시간 기준으로 누적 카운터 리셋.

### 사용 시간 추적
- **폴링**: 2초마다 `GetForegroundWindow` → process name + exe path + window title.
- **Idle 제외**: `GetLastInputInfo` 기준 60초 무입력 구간은 사용 시간에서 제외.
- **세션 단위**: 연속된 동일 foreground 프로세스 = 1 세션 (앱 전환/idle로 종료).
- **저장**: Local SQLite가 source of truth. Firebase에는 일별 집계(프로세스명 × 초)만.
- **창 제목**: 로컬 SQLite에만 저장, Firebase로 나가지 않음 (프라이버시 보호 — 문서명/URL 등 노출 방지).

### Anti-bypass
- Windows Service + Recovery 자동 재시작.
- 시계 조작 감지: 로컬 시각 vs `serverTimestamp` 편차 > 5분이면 잠금 유지 + 부모에게 알림.
- 네트워크 단절: 마지막 알려진 스케줄로 계속 운영, 스케줄 미존재 시 fail-closed.
- Task Manager / regedit 차단은 구현하지 않음 — Windows 표준 사용자 프로필로 관리자 권한을 애초에 막는 것이 정답.

## Firebase RTDB schema

```
/users/{uid}/devices/{deviceId}: "owner" | "viewer"

/devices/{deviceId}/
  meta:      { name, registeredAt, timezone }
  state:     { locked, lockReason, lastHeartbeat, onlineUser, todayUsedMinutes, agentVersion }
  schedule:
    allowedRanges:  [{ days: number[], start: "HH:MM", end: "HH:MM" }]
    dailyLimitMinutes: number
    perAppLimits:   { [processName]: number }     // 분 단위
  usage/{YYYY-MM-DD}/{processName}: seconds       // 일별 집계
  commands/{cid}:
    { type, payload, issuedAt, issuedBy, consumed, consumedAt }
```

### 보안 규칙 요지
- `state` — 에이전트 write, owner read.
- `commands` — owner write, 에이전트 read + `consumed` 필드만 update.
- `schedule` — owner write, 에이전트 read.
- `usage` — 에이전트 write, owner read.
- 페어링 시 `/users/{uid}/devices/{deviceId}`와 `/devices/{deviceId}/meta`를 트랜잭션으로 함께 생성.

## Directory layout

```
agent/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs           # Tauri + service dispatcher
│       ├── service.rs        # Windows Service 라이프사이클
│       ├── lock/
│       │   ├── overlay.rs    # 전체화면 오버레이 창 제어
│       │   ├── system.rs     # Win32 LockWorkStation 등 (폴백)
│       │   └── pin.rs        # 로컬 PIN 검증 (DPAPI 저장)
│       ├── schedule.rs       # 스케줄 + 일일 한도 + 앱 한도 평가
│       ├── usage.rs          # foreground 폴링 + idle 감지
│       ├── storage.rs        # SQLite: sessions, daily_summary, pin_hash
│       ├── firebase.rs       # RTDB REST + SSE streaming 클라이언트
│       └── commands.rs       # 명령 디스패처
└── ui/                       # Tauri 프론트엔드 (React + TS)
    ├── src/
    │   ├── overlay/          # 전체화면 잠금 UI (PIN 입력 포함)
    │   ├── tray/             # 트레이 상태 창
    │   └── shared.ts         # import from @ticktock/shared

mobile/
├── app.json
└── src/
    ├── screens/              # Login, Devices, Control, Schedule, Usage
    ├── firebase.ts
    └── types.ts              # re-export @ticktock/shared

shared/
└── src/types.ts              # Command, DeviceState, Schedule, UsageSummary
```

## Commands

> 스캐폴딩 완료 후 실제 스크립트로 대체.

```bash
# agent (Windows)
cd agent
npm install
npm run tauri dev                     # 서비스 없이 창만 (개발)
npm run tauri build                   # MSI 배포 빌드
cargo test --manifest-path src-tauri/Cargo.toml

# agent 서비스 설치 (관리자 PowerShell)
./ticktock-agent.exe --install-service
./ticktock-agent.exe --uninstall-service

# mobile
cd mobile
npm install
npx expo start
npx expo run:android

# shared 타입 빌드 (mobile/agent가 import)
cd shared && npm run build
```

## Key decisions & rationale

- **Tauri + Rust**: RN과 React 컴포넌트/TS 타입 공유, ~5MB 바이너리, `windows` crate로 Win32 풀접근.
- **Firebase RTDB**: MQTT 운영 부담 없이 양방향 실시간 채널 + SSE로 Rust에서 구독 단순. Firestore보다 latency 낮고 스키마가 단순.
- **하드 오버레이가 유일한 방어선**: Windows 암호를 없애 UX를 단순화하는 대신 에이전트 가용성이 핵심. Service Recovery가 절대 보장되어야 함.
- **창 제목은 로컬 전용**: 문서명·URL이 부모 앱으로 나가면 사생활 침해. 프로세스명·시간만 원격에서 보이고, 세부는 PC 앞에서만.
- **PIN 폴백은 필수**: 폰 분실/배터리 방전/Firebase 장애 시 해제 경로 없으면 사용 불가. PIN 해시는 DPAPI로 OS 사용자 세션에 바인딩.

## 미결정 / 후속 과제

- 페어링 UX: PC 오버레이에 6자리 코드 표시 → 부모가 앱에서 입력. (우선 이 방향으로 진행)
- 자녀 멀티프로필: 디바이스 1:1 가정으로 시작, Windows 사용자별 분리는 v2.
- `firebase-rs` crate 성숙도 확인 필요 — 부족하면 REST + `eventsource-client` 수동 조립.
- 오버레이에서 "긴급 요청" 버튼 → 부모 앱에 푸시 알림 (FCM) — v1.1 고려.
