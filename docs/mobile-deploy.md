# 부모 앱 (iOS) 배포 가이드

## 아키텍처

- **초기 설치**: Apple Developer 계정 → TestFlight 업로드 → 가족 이메일 초대 → 설치
- **이후 업데이트**: `eas update --channel production` 로 JS/React 번들만 OTA 전송. **Apple 재심사 없음.**
- **네이티브 코드 변경 시** (SDK 업그레이드, 새 네이티브 모듈 추가 등): 다시 빌드 + TestFlight 업로드 필요

## 1회성 준비 (태훈님 작업)

### 1.1 EAS CLI 설치 + Expo 로그인
```powershell
npm install -g eas-cli
eas login           # Expo 계정 (무료, 이미 Expo Go 로그인 되어있으면 그거 사용)
```

### 1.2 프로젝트 초기화 + projectId 자동 주입
```powershell
cd D:/Projects/TickTock/mobile
eas init            # Expo 서버에 프로젝트 생성 + app.json 의 REPLACE_WITH_PROJECT_ID 를 실제 ID 로 교체
```

### 1.3 Apple Developer 자격 연동
```powershell
eas credentials     # 또는 아래 build 명령 중 자동으로 묻는다
```
대화형으로 Apple ID / 팀 / 프로비저닝 프로파일 생성. 처음 한 번만.

### 1.4 첫 TestFlight 빌드 + 제출
```powershell
eas build -p ios --profile production       # Expo 서버에서 15~20분 빌드
eas submit -p ios --latest                   # App Store Connect (TestFlight) 제출
```

App Store Connect 에서 TestFlight 에 빌드 등장 → 내부 테스터 (가족 이메일) 초대 → 가족 iPhone 의 TestFlight 앱에서 "TickTock 설치".

## 일상 업데이트 (심사 없음)

JS/React 코드 수정 후:

```powershell
cd D:/Projects/TickTock/mobile
eas update --channel production --message "버그 수정"
```

몇 초~1분 내 업로드 완료. 가족 iPhone 앱이 **다음 실행 시 자동 다운로드** (또는 현재 실행 중이면 다음 포그라운드 진입 시).

### 업데이트 가능 범위
- ✅ JS/TypeScript 로직 변경
- ✅ React 컴포넌트 / 스타일
- ✅ 이미지, JSON 등 정적 자산
- ❌ `expo install ...` 로 새 네이티브 모듈 추가
- ❌ `app.json` 의 네이티브 설정 변경 (plugins, permissions 등)
- ❌ Expo SDK 버전 업그레이드

네이티브 변경 시: `eas build -p ios --profile production` + `eas submit` 재실행 필요.

## 채널 개념

`eas.json` 의 build profile → 각 빌드가 특정 `channel` 에 묶임:
- `production` 채널 빌드 → `eas update --channel production` 만 수신
- `preview` 채널 빌드 → `eas update --channel preview` 만 수신

운영 중 실험은 `preview` 에, 안정화되면 `production` 으로 promote.

## 롤백

실수로 나쁜 업데이트 푸시했을 때:
```powershell
eas update:list --channel production
# 이전 업데이트 ID 복사 후
eas update:republish --branch production --group <previous-group-id>
```

## 비용

- **Apple Developer**: $99/년 (이미 있음)
- **Expo EAS**: 무료 tier 로 **월 1000명 활성 유저 / 30 iOS build / 30 Android build** 까지 OK. 가족 5명 이내면 평생 무료 tier 로 충분
- **EAS Update**: 동일 무료 tier 에 포함

## 문제 해결

### 가족이 TestFlight 에서 앱 못 찾음
App Store Connect → TestFlight → 내부 테스터에 이메일 추가 → 초대 이메일 전송

### 업데이트가 적용 안 됨
- 앱을 한 번 완전 종료 후 재실행
- `runtimeVersion` 이 빌드 버전과 맞는지 (네이티브 변경 후 OTA 는 작동 안 함)

### TestFlight 빌드 90일 만료
- 새 빌드 올리면 만료 연장
- 가족이 계속 쓰려면 주기적으로 build + submit
