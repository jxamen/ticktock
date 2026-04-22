# CLAUDE.md

> **최종 업데이트**: 2026-04-22

## 프로젝트 지침

- 사용자를 **"태훈님"** 이라고 부를 것
- **모든 응답은 한국어**로 작성
- 코드(변수명, 함수명, 주석)는 **영어** 사용
- 기술 용어는 영어 그대로 (Controller, Service, Migration, Workers 등)
- 속도보다 **정확성**을 우선

## Project: TickTock

부모가 자녀의 Windows PC 사용을 **원격(외부 네트워크 포함)** 및 **로컬**에서 제어하는 시스템. Firebase Realtime Database 를 릴레이로 사용해 NAT/방화벽 뒤의 PC 를 제어하고, 사용자별·앱별 사용 시간을 추적한다.

- `agent/` — Windows PC 에이전트 (Rust + Tauri 2, Windows Service 로 설치)
- `mobile/` — 부모용 원격 제어 앱 (React Native + Expo)
- `web/` — 부모용 웹 관리 콘솔 (Next.js 16 + Cloudflare Workers + D1)
- `shared/` — 공용 TypeScript 타입 및 RTDB 스키마
- `docs/` — Firebase 설정, 페어링, 배포 가이드

## 현재 개발 단계

- **Phase 1 — 에이전트 MVP** ✅ **완료** (v0.1.6, 2026-04-22 기준)
  - Windows Service + Session Spawner, 오버레이, 스케줄 평가, 사용량 폴링, PIN, primary_user 가드
- **Phase 2 — 웹 관리 콘솔** 🔄 **진행 중 (이번 단계)**
  - 사용자/디바이스 관리, 페어링, 스케줄 편집, 사용량 대시보드, 명령 발행 UI
- **Phase 3 — 모바일 앱** ⏳ 대기
  - React Native + Expo. 로그인, 디바이스 선택, 간단 제어, 푸시 알림
- **최종 마감 (Polish)** — 긴급 요청 버튼, FCM 알림, 멀티프로필 — Phase 2/3 이후

## 기술 스택

### 에이전트 (`agent/`)
| 영역 | 기술 |
|------|------|
| 런타임 | Rust + Tauri 2 |
| OS 통합 | Windows Service + `windows` crate (Win32) |
| 로컬 DB | SQLite (`rusqlite`) |
| 통신 | Firebase RTDB REST + SSE streaming |

### 웹 (`web/`) — 이번 구현
| 영역 | 기술 |
|------|------|
| 프론트엔드 | Next.js 16 + React 19 + TypeScript |
| 스타일링 | Tailwind CSS 4 (Toss 스타일 CSS Variables) |
| 폰트 | Pretendard Variable |
| 백엔드 API | Next.js API Routes + Cloudflare Workers |
| DB | Cloudflare D1 (SQLite) + **Drizzle ORM** |
| 캐시/세션 | Cloudflare KV |
| 파일 | Cloudflare R2 |
| 인증 | 자체 JWT (PBKDF2 해시) + Firebase Admin SDK 브릿지 |
| 배포 | Cloudflare Pages + Workers (opennextjs-cloudflare) |

### 모바일 (`mobile/`)
| 영역 | 기술 |
|------|------|
| 런타임 | React Native + Expo |
| 인증 | Firebase Auth |
| 실시간 | Firebase RTDB |

## 핵심 보안 모델

**Windows 로그인 암호를 사용하지 않는다.** Windows 는 자동 로그인으로 설정되고, 유일한 방어선은 TickTock 에이전트의 하드 잠금 오버레이이다.

- 부팅 → 자동 로그인 → 서비스 시작 → **오버레이 즉시 ON (fail-closed)**
- 부모 앱/웹 또는 PC 의 PIN 입력으로만 해제
- 오버레이 = Tauri 전체화면 창 (topmost, 포커스 고정, 시스템 키 조합 차단)
- 서비스가 중지되면 오버레이가 사라질 수 있으므로 Service Recovery 옵션으로 즉시 자동 재시작

이 모델에서 **Windows 자격 증명은 저장·전송·입력될 일이 없다.**

## Architecture

```
 [RN 부모 앱]  ──write command──►  [Firebase RTDB]  ──SSE stream──►  [Windows 에이전트]
 [웹 관리 콘솔]                     /devices/{id}                        │
      ▲                                                                  │
      └──── state/heartbeat ◄──── /state ◄────── write ──────────────────┘
                                                                         │
                                                     [Local SQLite: usage/sessions]
                                                                         │
                                                                         ▼
                                                  5분마다 /usage/{date} 집계 push

 [웹 관리 콘솔]  ──Drizzle──►  [Cloudflare D1]  (부모 계정, 페어링, 권한, 감사 로그)
                     │
                     └── Firebase Admin SDK ──► /devices/{id}/* (읽기 + 명령 쓰기)
```

### 통신 모델
- **Command 채널** (`/devices/{id}/commands/{cid}`): 부모(앱/웹)가 쓰기 → 에이전트 소비 후 `consumed: true` 업데이트. 타입: `lock`, `unlock`, `setSchedule`, `setAppLimit`, `grantBonus`.
- **State 채널** (`/devices/{id}/state`): 에이전트가 30초 heartbeat + 상태 변경 즉시 push.
- **Usage 채널** (`/devices/{id}/usage/{YYYY-MM-DD}/{processName}`): 5분마다 하루 누적 초 단위 집계 push.
- **오프라인 복원**: 에이전트 재연결 시 `consumed: false` 명령을 `issuedAt` 오름차순으로 모두 처리.

## 핵심 명령어

### 웹 (`web/`)
```bash
cd web
npm install
npm run dev                        # Next.js 개발 서버 (포트 3001)
npm run build                      # 프로덕션 빌드
npm run lint                       # ESLint 검사
npx wrangler dev                   # Workers 로컬 개발
npx drizzle-kit generate           # Drizzle 마이그레이션 생성
npm run db:migrate                 # D1 로컬 마이그레이션 적용
npm run db:migrate:remote          # D1 원격 마이그레이션 적용
npm run deploy                     # Cloudflare 배포
```

### 에이전트 (`agent/`)
```bash
cd agent
npm run tauri dev                  # 서비스 없이 창만 (개발)
npm run tauri build                # MSI 배포 빌드
./ticktock-agent.exe --install-service    # 관리자 PowerShell
./ticktock-agent.exe --uninstall-service
```

### 모바일 (`mobile/`)
```bash
cd mobile
npx expo start
npx expo run:android
```

## 핵심 규칙 (요약)

상세와 예시는 `.claude/rules/` · `.claude/docs/coding-standards.md` · `.claude/docs/architecture.md` 에서 관리.

| 규칙 | 내용 | 상세 |
|------|------|------|
| DB 접근 | Drizzle ORM 전용 (로우 SQL 금지, `sql` 템플릿 리터럴만 허용) | [rules/code-style.md §8](.claude/rules/code-style.md) |
| Thin Route / Thick Service | Route 는 검증+위임만. 로직은 `lib/services/` | [rules/code-style.md §1](.claude/rules/code-style.md) |
| 입력 검증 | Zod 스키마 필수 | [rules/api-design.md §6](.claude/rules/api-design.md) |
| Append-Only 원장 | `*_ledger`, `*_logs` 에 UPDATE/DELETE 금지 | [rules/api-design.md §5](.claude/rules/api-design.md) |
| 스코프 강제 | 부모(owner/viewer) 가 아닌 디바이스는 모든 쿼리에서 제외 | [rules/api-design.md §1](.claude/rules/api-design.md) |
| 민감 데이터 비노출 | 창 제목 · PIN 해시 · Firebase private key 외부 응답 제거 | [rules/api-design.md §2](.claude/rules/api-design.md) |
| 민감 정보 암호화 | Firebase Admin key → Workers Secrets, PIN 해시 → DPAPI (에이전트) | [docs/coding-standards.md](.claude/docs/coding-standards.md) |
| 색상 하드코딩 금지 | `bg-[#XXX]` / Tailwind 기본색 직접 사용 금지. CSS Variables 매핑만 | [docs/design.md](.claude/docs/design.md) |
| 감사 로그 | PIN 변경, 디바이스 등록/해제, 강제 잠금/해제, 권한 변경 | [rules/api-design.md §7](.claude/rules/api-design.md) |

## Cloudflare 저장소 역할 분리 (잘못된 저장소 사용 금지)

| 저장소 | 용도 | 예시 |
|--------|------|------|
| **D1** | 영속 비즈니스 데이터 (관계형) | 부모 계정, 디바이스 메타, 권한, 감사 로그 |
| **KV** | 읽기 위주 설정/캐시 (eventual) | 세션, 페어링 코드(TTL), 토큰 |
| **R2** | 대용량 파일 | 사용량 CSV 아카이브, 스크린샷(선택) |
| **Firebase RTDB** | 실시간 에이전트 통신 | 명령, state, usage live |

## API 라우팅 기준

| 유형 | 위치 |
|------|------|
| 웹 CRUD | Next.js API Routes (`web/src/app/api/`) |
| Firebase 브릿지 / 스케줄 푸시 / 배치 | Cloudflare Workers (`web/src/workers/`) |

## 반응형 UI 규칙

모든 테이블·카드·모달·필터 바는 **반응형 필수**. 고정 `grid-cols-N` 금지 → 반드시 반응형 prefix 포함.

```
카드 그리드:   grid-cols-1 sm:grid-cols-2 lg:grid-cols-4
2열 그리드:   grid-cols-1 md:grid-cols-2
테이블:       overflow-x-auto 래퍼 + min-w-[600px]
모달:         w-[calc(100%-2rem)] max-w-{size}
필터 바:      flex-wrap gap-3
페이지 컨테이너: px-4 md:px-6
```

## D1 (SQLite) 제약사항

- `ENUM` → `TEXT CHECK(col IN (...))` / `DATETIME` → `TEXT` (ISO 8601) / `JSON` → `TEXT`
- `BOOLEAN` → `INTEGER` (0/1) / 트랜잭션: D1 batch API 사용
- 10GB 제한 → 집계 데이터는 Firebase RTDB 에만 상세, D1 은 요약만

## 코딩 패턴 (요약)

- 들여쓰기 4 spaces · TypeScript strict (`any` 금지)
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- 브랜치: `feature/*`, `bugfix/*`, `hotfix/*`
- 소프트 삭제: `is_active` / 감사 필드: `created_by`·`updated_by`·`created_at`·`updated_at`

## 디자인 시스템 (Toss 기반)

- **참조**: [.claude/docs/design.md](.claude/docs/design.md)
- 흰색 베이스 + 토스 블루 액센트 (`#3182f6`) + 딥 그레이 헤딩 (`#191f28`)
- Pretendard Variable 폰트, `tabular-nums`
- 부드러운 그림자, Border radius 6~16px
- 위 값은 기본 프리셋, 추후 테마 확장 가능

### UI 폰트 크기 규칙
- 한 영역 내 모든 행은 **동일한 폰트 크기** (셀별 override 금지)
- 강조는 굵기/색상으로, 크기 차별화 X
- **테이블 기본**: 본문 `text-[14px]` / 헤더 `text-[13px]` / 배지·보조버튼 `text-[12px]` / 셀 padding `px-4 py-3`

## 디렉토리 구조

```
TickTock/
├── agent/                  # Windows 에이전트 (Rust + Tauri)
├── mobile/                 # 부모용 앱 (RN + Expo)
├── web/                    # 웹 관리 콘솔 (Next.js + Cloudflare)
│   ├── src/
│   │   ├── app/            # Next.js App Router
│   │   │   ├── (admin)/    # 부모 관리자 화면
│   │   │   ├── (auth)/     # 로그인 / 회원가입 / 페어링
│   │   │   └── api/        # API Routes
│   │   ├── components/
│   │   │   ├── layout/     # Header, Sidebar
│   │   │   └── common/     # 공용 UI
│   │   ├── lib/
│   │   │   ├── db/schema/  # Drizzle 스키마 (도메인별)
│   │   │   ├── services/   # 비즈니스 로직
│   │   │   ├── validators/ # Zod 스키마
│   │   │   ├── utils/      # crypto, jwt, password, ulid
│   │   │   └── middleware/ # auth
│   │   └── workers/        # Cloudflare Workers (Firebase 브릿지 등)
│   └── migrations/         # D1 마이그레이션
├── shared/                 # 공용 타입 (@ticktock/shared)
└── docs/
```

## 시드 데이터 필수

- 기능 구현 완료 후 **반드시 시드 데이터를 삽입**할 것
- 시드 SQL 파일: 프로젝트 루트에 `seed-*.sql` 형태로 생성 → `wrangler d1 execute --local --file=` 로 적용
- 비밀번호는 `password.ts` 의 PBKDF2 해시로 생성
- 시드 계정 비밀번호: `test1234`

## 문서 자동 갱신

| 변경 | 갱신 대상 |
|------|-----------|
| 새 API | `api-guidelines.md` + 도메인 `data-structure.md` |
| DB 스키마 | 도메인 `data-structure.md` |
| 비즈니스 로직 | 도메인 `business-flow.md` |
| 아키텍처 | `architecture.md` |

## 배포 시나리오 (v1 실사용)

**자녀 전용 PC 가 아니라, 한 대 PC 에 Windows 계정이 2개 (자녀 / 부모) 공존하는 구성** 이다. 부모 계정은 관리자, 자녀 계정은 표준 사용자. TickTock 은 자녀 계정에서만 동작해야 하며, 부모가 계정 전환으로 자리에 앉았을 때는 오버레이가 뜨면 안 된다.

- Windows Service (LocalSystem) + Session Spawner 가 Win32 `WTSGetActiveConsoleSessionId` 로 현재 console session 에 user-session child 를 spawn — 이 때문에 부모 세션에서도 child 가 뜨려고 함.
- **Primary-user 가드**: 첫 실행(PIN 설정)을 완료한 Windows 사용자명을 kv 의 `primary_user` 로 기록. bootstrap 에서 현재 user 와 비교 후 다르면 즉시 `exit(0)`.

## `.claude/` 레퍼런스

```
.claude/
├── agents/     # backend, fe, dba, reviewer, tester, security, integration, deployment
├── commands/   # commit-push, verify-app, code-simplifier, check-domain
├── docs/       # progress, architecture, design, local-development, api-guidelines, coding-standards
│   └── domains/  # auth, devices, pairing, schedule, usage, commands, pin, overlay
├── rules/      # api-design, code-style, testing
└── settings.local.json
```

도메인 목록: auth, devices, pairing, schedule, usage, commands, pin, overlay

상세: [Phase 진행](.claude/docs/progress.md) | [도메인 관계도](.claude/docs/domains/README.md) | [아키텍처](.claude/docs/architecture.md) | [디자인](.claude/docs/design.md) | [API 가이드](.claude/docs/api-guidelines.md) | [코딩 표준](.claude/docs/coding-standards.md)
