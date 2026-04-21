# 개발 시작하기

스캐폴딩과 의존성 설치까지 완료된 상태에서 실제 개발을 시작하려면 아래 단계가 필요합니다. 1번과 2번은 한 번만 해두면 됩니다.

## 1. Rust 툴체인 설치 (에이전트 빌드용)

https://rustup.rs 에서 `rustup-init.exe` 다운로드 → 실행 → 기본 옵션으로 설치.

설치 확인:
```bash
rustc --version
cargo --version
```

Visual Studio Build Tools(MSVC)가 없으면 rustup이 안내하는 링크로 함께 설치. `rusqlite` (bundled SQLite) 컴파일에 C 컴파일러가 필요합니다.

## 2. Firebase 프로젝트 생성

상세 절차는 [firebase-setup.md](./firebase-setup.md) 참조. 요약:

1. https://console.firebase.google.com 에서 프로젝트 생성
2. Authentication → Email/Password 활성화 + 부모 계정 추가
3. Realtime Database 생성 (서울 근접 리전) + 보안 규칙 붙여넣기
4. 웹 앱 등록 → `firebaseConfig` 복사 → `mobile/app.json`의 `extra.firebase`에 붙여넣기
5. Cloud Function `claimPairingCode` 배포 (페어링용)
6. RTDB URL (`https://<project>.firebaseio.com`)을 메모 — agent 빌드에 사용

## 3. 에이전트 환경변수

`agent/` 빌드 전 RTDB URL을 환경변수로 주입:

```powershell
# PowerShell (세션에서만 유효)
$env:TICKTOCK_RTDB_URL = "https://your-project.firebaseio.com"
```

영구 설정은 `setx TICKTOCK_RTDB_URL "..."` 또는 시스템 환경변수 설정.

## 4. 빌드 & 실행

### 모바일 앱
```bash
cd mobile
npx expo start
# Expo Go 앱으로 QR 스캔 또는 `npx expo run:android`
```

### 에이전트 (개발 모드)
```bash
cd agent
npm run tauri:dev
```

첫 실행 시 Rust crate 컴파일에 5~10분 소요. 이후는 증분 빌드로 빠름.

### 에이전트 (배포 빌드)
```bash
cd agent
npm run tauri:build
# 결과: src-tauri/target/release/bundle/msi/TickTock_*.msi
```

### 서비스 등록 (관리자 PowerShell)
```powershell
# MSI로 설치하지 않고 직접 테스트할 때
.\ticktock-agent.exe --install-service
.\ticktock-agent.exe --uninstall-service
```

서비스는 현재 파크 모드(세션-0 격리로 UI 표출 불가). 개발 중에는 `npm run tauri:dev`로 사용자 세션에서 직접 실행하는 것을 추천.

## 5. 첫 테스트 시나리오

1. 에이전트 개발 모드로 실행 → 오버레이 창이 전체화면으로 떠야 함 (fail-closed).
2. 우하단 48×48 영역 3회 클릭 → PIN 입력 칸 표시.
3. **PIN을 아직 설정하지 않았으므로** 먼저 개발자 콘솔에서 `invoke('set_pin', { pin: '1234' })` 실행 또는 일시적 개발용 스크립트로 등록.
4. 1234 입력 → 오버레이 해제.
5. 모바일 앱 로그인 → 디바이스 등록 → 잠금/해제 버튼 테스트.

## 6. 디버그 팁

- `RUST_LOG=debug` 환경변수로 상세 로그 활성화.
- SQLite 파일 위치: `%LOCALAPPDATA%\com.ticktock.agent\ticktock.sqlite` — DB Browser for SQLite로 열어 확인 가능.
- Firebase RTDB 콘솔의 Data 탭에서 실시간 state/commands 관찰.

## 현재 미구현 사항 (알려진 TODO)

- `register_device` Tauri command — Cloud Function과 연결 필요
- Overlay focus 재탈환 폴링 (Alt+Tab 시 다른 창이 포커스 가져가는 경우)
- 서비스가 user session에 Tauri 프로세스 스폰 (`CreateProcessAsUser` + WTS 세션 감지)
- 앱별 한도 초과 시 프로세스 강제 종료 (현재는 오버레이만 띄움)
