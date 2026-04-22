import { NextRequest } from "next/server";
import { verifyJwt } from "@/lib/utils/jwt";
import { errors } from "@/lib/utils/response";

export const AUTH_COOKIE = "ticktock_token";

/** 인증된 요청의 컨텍스트 */
export type AuthContext = {
    userId: string;
    email: string;
    jti: string;
};

/**
 * JWT 인증 — Authorization 헤더 or Cookie 에서 토큰을 읽고 검증.
 * 실패 시 errors.unauthenticated() Response 반환.
 */
export async function authenticate(
    req: NextRequest,
    env: CloudflareEnv,
): Promise<AuthContext | Response> {
    const token = extractToken(req);
    if (!token) return errors.unauthenticated();

    const payload = await verifyJwt(token, env.JWT_SECRET);
    if (!payload) return errors.unauthenticated();

    // Blacklist (강제 로그아웃 · 비밀번호 변경 이후) 확인
    const revoked = await env.CACHE.get(`session:blacklist:${payload.jti}`);
    if (revoked) return errors.unauthenticated();

    return {
        userId: payload.sub,
        email: payload.email,
        jti: payload.jti,
    };
}

/** 헤더 또는 쿠키에서 토큰 추출 */
function extractToken(req: NextRequest): string | null {
    const header = req.headers.get("Authorization");
    if (header?.startsWith("Bearer ")) return header.slice(7);

    const cookie = req.cookies.get(AUTH_COOKIE);
    return cookie?.value ?? null;
}

/**
 * 인증 필수 헬퍼. 실패 시 Response 반환.
 *
 * 사용법:
 *   const result = await requireAuth(req, env);
 *   if (result instanceof Response) return result;
 *   const ctx = result;
 */
export async function requireAuth(
    req: NextRequest,
    env: CloudflareEnv,
): Promise<AuthContext | Response> {
    return authenticate(req, env);
}
