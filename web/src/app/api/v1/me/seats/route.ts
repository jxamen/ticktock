import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import { getMySeats, PlanError } from "@/lib/services/plan/plan.service";
import { ok, errors, error as errorResponse } from "@/lib/utils/response";

export async function GET(req: NextRequest) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;

    try {
        const result = await getMySeats(auth.userId, { db });
        return ok(result);
    } catch (err) {
        if (err instanceof PlanError) return errorResponse(err.code, err.message, err.status);
        console.error("getMySeats failed", err);
        return errors.internal();
    }
}
