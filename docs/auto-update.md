# 자동 업데이트 배포 절차

TickTock은 Tauri updater 플러그인 + GitHub Releases 조합으로 자동 업데이트합니다.

- **신뢰성**: Ed25519 서명 검증 (공개키는 앱에 박혀있음)
- **체크 주기**: 부팅 60초 후 첫 체크, 이후 6시간마다
- **설치 방식**: `passive` — NSIS 설치 프로그램이 조용히 돌면서 서비스도 자동 재등록 (installer-hooks.nsh)

## 1회성 준비 (완료됨)

- 서명 키 쌍 생성: `%USERPROFILE%\.ticktock\signing.key` (+ `.pub`)
- 공개키는 `agent/src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 박힘
- **비밀키는 절대 커밋하지 말 것**. `.gitignore`에 `.ticktock/` 포함

## GitHub repo 초기 설정 (태훈님 작업)

```powershell
cd D:/Projects/TickTock
git init
git add .
git commit -m "Initial commit"

# GitHub에서 private repo 생성 (예: ticktock) 후:
git remote add origin https://github.com/<OWNER>/ticktock.git
git branch -M main
git push -u origin main
```

## Tauri 설정 업데이트

`agent/src-tauri/tauri.conf.json`의 endpoint에서 `OWNER_PLACEHOLDER`를 실제 GitHub 사용자명으로 교체:
```json
"endpoints": [
  "https://github.com/<OWNER>/ticktock/releases/latest/download/latest.json"
]
```

## 새 버전 배포 절차

### 1. 버전 증가

`agent/src-tauri/tauri.conf.json`의 `"version"` 필드 수정 (예: `0.1.0` → `0.1.1`).
`agent/src-tauri/Cargo.toml`의 `version`도 맞춤.

### 2. 서명 + 빌드

```powershell
cd D:/Projects/TickTock/agent
./scripts/sign-and-build.ps1
```

생성되는 파일:
- `src-tauri/target/release/bundle/nsis/TickTock_<ver>_x64-setup.exe`
- `src-tauri/target/release/bundle/nsis/TickTock_<ver>_x64-setup.exe.sig` (서명)

### 3. `latest.json` 작성

```json
{
  "version": "0.1.1",
  "notes": "버그 수정 및 안정성 개선",
  "pub_date": "2026-04-21T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<.sig 파일 내용 전체>",
      "url": "https://github.com/<OWNER>/ticktock/releases/download/v0.1.1/TickTock_0.1.1_x64-setup.exe"
    }
  }
}
```

`signature` 필드에는 `.sig` 파일을 텍스트로 열어 **전체 내용을 그대로** 붙여넣습니다.

### 4. GitHub Release 생성 + 업로드

```powershell
gh release create v0.1.1 `
  --title "v0.1.1" `
  --notes "버그 수정 및 안정성 개선" `
  "./src-tauri/target/release/bundle/nsis/TickTock_0.1.1_x64-setup.exe" `
  "./src-tauri/target/release/bundle/nsis/TickTock_0.1.1_x64-setup.exe.sig" `
  "./latest.json"
```

`gh` CLI 필요 (`winget install GitHub.cli`). 수동 업로드면 웹에서 Release 생성 후 3개 파일 드래그.

**중요**: tag는 `v` prefix 포함 (`v0.1.1`). `latest.json`은 반드시 파일명 그대로.

### 5. 확인

- GitHub Release 페이지에서 3개 파일 모두 첨부 확인
- 브라우저에서 `https://github.com/<OWNER>/ticktock/releases/latest/download/latest.json` 접속 → JSON 내용 보이면 OK

### 6. 자녀 PC 동작

- 기존 설치된 에이전트가 6시간 내에 자동 체크 → 다운로드 → 조용히 설치 → 재시작
- 즉시 반영하려면 자녀 PC 재부팅 (부팅 후 60초 내 체크)

## 테스트

배포 전 로컬 테스트:
1. 버전 0.1.0 설치 상태 유지
2. `tauri.conf.json`의 version을 0.1.1로 올리고 빌드+서명
3. 위 latest.json을 로컬 파일로 만들어서 임시 웹서버(또는 GitHub pre-release)로 노출
4. endpoint를 그 URL로 바꾼 개발 빌드에서 동작 확인

## 주의사항

- **비밀키 분실 시**: 기존 설치된 에이전트는 서명 검증 실패로 업데이트 수신 불가. 새 키 쌍 생성 + 전체 자녀 PC 수동 재설치 필요. 반드시 백업.
- **체크 주기 6시간**: 긴급 수정이 필요하면 자녀 PC에서 수동 재부팅 시키거나 주기를 앞당긴 버전 배포.
- **비밀번호 없는 키**: 현재 무비밀번호로 생성됨. 비밀번호 보호하려면 재생성 + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env 세팅.
