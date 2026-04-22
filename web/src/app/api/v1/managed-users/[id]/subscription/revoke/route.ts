import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import { revokeSubscription } from "@/lib/services/subscription/subscription.service";
import { ManagedUserError } from "@/lib/services/subscription/managed-user.service";
import { ok, errors, error as errorResponse } from "@/lib/utils/response";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

const revokeSchema = z.object({
    note: z.string().max(500).optional(),
});

export async function POST(req: NextRequest, ctx: Ctx) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const parsed = revokeSchema.safeParse(body ?? {});
    if (!parsed.success) {
        return errors.validationFailed("입력을 확인해주세요");
    }

    try {
        const ip = req.headers.get("cf-connecting-ip") ?? undefined;
        const result = await revokeSubscription(auth.userId, id, { db }, { ip, note: parsed.data.note });
        return ok(result);
    } catch (err) {
        if (err instanceof ManagedUserError) return errorResponse(err.code, err.message, err.status);
        console.error("revokeSubscription failed", err);
        return errors.internal();
    }
}
