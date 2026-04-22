import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { verifyJwt } from "@/lib/utils/jwt";
import { AUTH_COOKIE } from "@/lib/middleware/auth";

/**
 * Server Component 에서 현재 세션을 얻는다. 무효면 /login 리다이렉트.
 */
export async function requireSession() {
    const store = await cookies();
    const token = store.get(AUTH_COOKIE)?.value;
    if (!token) redirect("/login");

    const { db, env } = await getEnv();
    const payload = await verifyJwt(token, env.JWT_SECRET);
    if (!payload) redirect("/login");

    const revoked = await env.CACHE.get(`session:blacklist:${payload.jti}`);
    if (revoked) redirect("/login");

    return {
        userId: payload.sub,
        email: payload.email,
        jti: payload.jti,
        db,
        env,
    };
}
