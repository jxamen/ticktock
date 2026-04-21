# Firebase 프로젝트 설정

TickTock은 Firebase Realtime Database를 에이전트 ↔ 모바일 앱 간 릴레이로 사용합니다.

## 1. 프로젝트 생성

1. https://console.firebase.google.com 에서 새 프로젝트 생성.
2. Google Analytics는 비활성화해도 됩니다 (가정용이므로).

## 2. Authentication

- **Sign-in method** → **Email/Password** 활성화.
- 부모 본인의 계정 1개 생성 (Users 탭에서 직접 추가).

## 3. Realtime Database

- **Create database** → 리전은 `asia-southeast1` 권장 (서울에서 가장 가까움).
- 시작 모드는 **Locked**로 선택 (아래에서 규칙 교체).
- Rules 탭에 아래 규칙을 붙여넣고 **Publish**:

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    },
    "devices": {
      "$deviceId": {
        ".read": "auth != null && (root.child('users/' + auth.uid + '/devices/' + $deviceId).exists() || auth.token.deviceId === $deviceId)",

        "state": {
          ".write": "auth.token.deviceId === $deviceId"
        },
        "usage": {
          ".write": "auth.token.deviceId === $deviceId"
        },
        "meta": {
          ".write": "auth != null && root.child('users/' + auth.uid + '/devices/' + $deviceId).val() === 'owner'"
        },
        "schedule": {
          ".write": "auth != null && root.child('users/' + auth.uid + '/devices/' + $deviceId).val() === 'owner'"
        },
        "commands": {
          "$cid": {
            ".write": "auth != null && (
              (root.child('users/' + auth.uid + '/devices/' + $deviceId).val() === 'owner' && !data.exists()) ||
              (auth.token.deviceId === $deviceId && newData.child('consumed').val() === true)
            )"
          }
        }
      }
    }
  }
}
```

요약:
- 부모(`users/{uid}/devices/{deviceId}: "owner"`)는 meta/schedule 쓰기, command 생성 가능.
- 에이전트(custom token에 `deviceId` claim 포함)는 state/usage 쓰기, command `consumed` 업데이트만 가능.

## 4. 디바이스 페어링 (Cloud Function)

에이전트는 부모 계정의 비밀번호를 알 수 없으므로, 페어링은 **6자리 1회용 코드** 기반으로 진행합니다.

### 흐름
1. PC 에이전트 첫 실행 → 6자리 코드 생성 + `/pairing/{code}` 노드에 `{ createdAt, expiresAt: now+10min }` 쓰기. 오버레이에 코드 표시.
2. 부모 모바일 앱 로그인 → 코드 입력 → Cloud Function `claimPairingCode` 호출.
3. Function이 코드 검증 → 새 `deviceId` 발급 → `/users/{uid}/devices/{deviceId}: "owner"` 생성 → 에이전트용 custom token(`{ deviceId }`) 응답.
4. Function이 `/pairing/{code}/claimedBy: uid`도 써서 에이전트에 signal.
5. 에이전트가 `/pairing/{code}` 리스너에서 `claimedBy`를 감지 → custom token을 받아 저장 → 이후 정규 채널로 전환.

### Cloud Function 스캐폴드 (추후 작성)

```ts
// functions/src/pairing.ts
import * as functions from "firebase-functions";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

export const claimPairingCode = functions.https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError("unauthenticated", "login required");
  const code = String(data.code ?? "");
  const snap = await getDatabase().ref(`/pairing/${code}`).get();
  const pending = snap.val();
  if (!pending || pending.expiresAt < Date.now()) {
    throw new functions.https.HttpsError("not-found", "invalid or expired code");
  }
  const deviceId = crypto.randomUUID();
  await getDatabase().ref().update({
    [`/users/${ctx.auth.uid}/devices/${deviceId}`]: "owner",
    [`/devices/${deviceId}/meta`]: { name: "새 PC", registeredAt: Date.now(), timezone: "Asia/Seoul" },
    [`/pairing/${code}/claimedBy`]: ctx.auth.uid,
    [`/pairing/${code}/deviceId`]: deviceId,
  });
  const token = await getAuth().createCustomToken(`device-${deviceId}`, { deviceId });
  return { deviceId, token };
});
```

## 5. 클라이언트 설정값 주입

### 모바일 앱 (`mobile/app.json`)
`extra.firebase`에 웹 config 값 붙여넣기 (Firebase Console → 프로젝트 설정 → 웹 앱 추가).

### 에이전트 (`agent/src-tauri/src/firebase.rs`)
database URL + API key만 필요. 빌드 타임에 환경변수로 주입하거나 별도 설정 파일로 로드.

## 체크리스트

- [ ] Firebase 프로젝트 생성 + 리전 선택
- [ ] Email/Password Auth 활성화, 부모 계정 생성
- [ ] RTDB 생성 + 보안 규칙 붙여넣기
- [ ] Cloud Functions 배포 (`claimPairingCode`)
- [ ] `mobile/app.json`의 `extra.firebase` 채우기
- [ ] 에이전트 빌드 설정에 database URL 주입
