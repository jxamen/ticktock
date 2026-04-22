import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import { logout } from "@/lib/services/auth/auth.service";
import { verifyJwt } from "@/lib/utils/jwt";
import { AUTH_COOKIE } from "@/lib/middleware/auth";
import { clearAuthCookie } from "../_cookie";

export async function POST(req: NextRequest) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);

    // 인증 실패여도 쿠키는 지워주고 /login 으로 보냄
    if (auth instanceof Response) {
        return redirectToLogin();
    }

    const token = extractToken(req);
    if (token) {
        const payload = await verifyJwt(token, env.JWT_SECRET);
        if (payload) {
            await logout(payload.jti, payload.exp, {
                db,
                kv: env.CACHE,
                jwtSecret: env.JWT_SECRET,
            });
        }
    }

    return redirectToLogin();
}

function redirectToLogin() {
    const response = new Response(null, { status: 303, headers: { Location: "/login" } });
    response.headers.append("Set-Cookie", clearAuthCookie(AUTH_COOKIE));
    return response;
}

function extractToken(req: NextRequest): string | null {
    const header = req.headers.get("Authorization");
    if (header?.startsWith("Bearer ")) return header.slice(7);
    const cookie = req.cookies.get(AUTH_COOKIE);
    return cookie?.value ?? null;
}
