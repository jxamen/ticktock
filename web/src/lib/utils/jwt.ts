/**
 * JWT 발급/검증 — Web Crypto API (HMAC-SHA256)
 * Cloudflare Workers 호환
 */

export type JwtPayload = {
    sub: string;        // user_id (ULID)
    email: string;
    jti: string;        // 토큰 고유 ID (blacklist 용)
    iat: number;
    exp: number;
};

type TokenType = "access" | "refresh";

const ACCESS_TTL = 60 * 60;                // 1시간
const REFRESH_TTL = 60 * 60 * 24 * 14;     // 14일

/** JWT 토큰 발급 */
export async function signJwt(
    payload: Omit<JwtPayload, "iat" | "exp" | "jti">,
    secret: string,
    type: TokenType = "access",
): Promise<{ token: string; jti: string; exp: number }> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = type === "access" ? ACCESS_TTL : REFRESH_TTL;
    const jti = crypto.randomUUID();

    const fullPayload: JwtPayload = {
        ...payload,
        jti,
        iat: now,
        exp: now + ttl,
    };

    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = base64url(JSON.stringify(fullPayload));
    const signature = await sign(`${header}.${body}`, secret);

    return {
        token: `${header}.${body}.${signature}`,
        jti,
        exp: fullPayload.exp,
    };
}

/** JWT 토큰 검증 → 페이로드 반환 (실패 시 null) */
export async function verifyJwt(
    token: string,
    secret: string,
): Promise<JwtPayload | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const expected = await sign(`${header}.${body}`, secret);

    if (!timingSafeEqual(signature, expected)) return null;

    let payload: JwtPayload;
    try {
        payload = JSON.parse(base64urlDecode(body));
    } catch {
        return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    return payload;
}

// ─── 내부 헬퍼 ───

async function sign(data: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(data),
    );
    return base64url(sig);
}

function base64url(input: string | ArrayBuffer): string {
    const str =
        typeof input === "string"
            ? btoa(input)
            : btoa(String.fromCharCode(...new Uint8Array(input)));
    return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): string {
    const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
    const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    return atob(base64);
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}
