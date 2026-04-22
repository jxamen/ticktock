/// <reference types="@opennextjs/cloudflare/runtime" />

// Cloudflare 바인딩 타입
// wrangler.jsonc 에 선언된 바인딩과 일치해야 함
interface CloudflareEnv {
    // D1 데이터베이스
    DB: D1Database;
    // KV 네임스페이스 (세션, 페어링 코드)
    CACHE: KVNamespace;
    // R2 버킷
    FILES: R2Bucket;

    // 환경 변수 (Workers Secrets)
    JWT_SECRET: string;
    ENCRYPTION_KEY: string;
    APP_BASE_URL: string;

    // Firebase Admin — 에이전트가 RTDB 에 쓴 상태/사용량 조회용 (선택)
    FIREBASE_PROJECT_ID: string;
    FIREBASE_CLIENT_EMAIL: string;
    FIREBASE_PRIVATE_KEY: string;
    FIREBASE_DB_URL: string;
}
