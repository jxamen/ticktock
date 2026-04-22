import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import { getMe, AuthError } from "@/lib/services/auth/auth.service";
import { ok, errors, error as errorResponse } from "@/lib/utils/response";

export async function GET(req: NextRequest) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;

    try {
        const me = await getMe(auth.userId, {
            db,
            kv: env.CACHE,
            jwtSecret: env.JWT_SECRET,
        });
        return ok(me);
    } catch (err) {
        if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
        console.error("getMe failed", err);
        return errors.internal();
    }
}
