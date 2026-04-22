import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import { setMySeatLimit, PlanError } from "@/lib/services/plan/plan.service";
import { setSeatLimitSchema } from "@/lib/validators/plan.validator";
import { ok, errors, error as errorResponse } from "@/lib/utils/response";

export async function POST(req: NextRequest) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;

    const body = await req.json().catch(() => null);
    const parsed = setSeatLimitSchema.safeParse(body);
    if (!parsed.success) {
        return errors.validationFailed(parsed.error.issues[0]?.message ?? "입력을 확인해주세요");
    }

    try {
        const ip = req.headers.get("cf-connecting-ip") ?? undefined;
        const result = await setMySeatLimit(auth.userId, parsed.data, { db }, { ip });
        return ok(result);
    } catch (err) {
        if (err instanceof PlanError) return errorResponse(err.code, err.message, err.status);
        console.error("setSeatLimit failed", err);
        return errors.internal();
    }
}
