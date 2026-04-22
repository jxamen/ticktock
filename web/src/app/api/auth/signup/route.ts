import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { signupSchema } from "@/lib/validators/auth.validator";
import { signup, AuthError } from "@/lib/services/auth/auth.service";
import { ok, errors, error as errorResponse } from "@/lib/utils/response";
import { AUTH_COOKIE } from "@/lib/middleware/auth";
import { buildAuthCookie } from "../_cookie";

export async function POST(req: NextRequest) {
    try {
        const { db, env } = await getEnv();
        const body = await req.json().catch(() => null);
        const parsed = signupSchema.safeParse(body);
        if (!parsed.success) {
            return errors.validationFailed(parsed.error.issues[0]?.message ?? "입력을 확인해주세요");
        }

        const ip = req.headers.get("cf-connecting-ip") ?? undefined;
        const result = await signup(
            parsed.data,
            { db, kv: env.CACHE, jwtSecret: env.JWT_SECRET },
            { ip },
        );

        const response = ok(
            {
                userId: result.userId,
                email: result.email,
                displayName: result.displayName,
            },
            201,
        );
        response.headers.append(
            "Set-Cookie",
            buildAuthCookie(AUTH_COOKIE, result.token, result.exp),
        );
        return response;
    } catch (err) {
        if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
        console.error("signup failed", err);
        return errors.internal();
    }
}
