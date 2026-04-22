import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import { listSubscriptionLedger } from "@/lib/services/subscription/subscription.service";
import { ManagedUserError } from "@/lib/services/subscription/managed-user.service";
import { ok, errors, error as errorResponse } from "@/lib/utils/response";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;
    const { id } = await ctx.params;

    try {
        const rows = await listSubscriptionLedger(auth.userId, id, { db });
        return ok(rows);
    } catch (err) {
        if (err instanceof ManagedUserError) return errorResponse(err.code, err.message, err.status);
        console.error("listLedger failed", err);
        return errors.internal();
    }
}
