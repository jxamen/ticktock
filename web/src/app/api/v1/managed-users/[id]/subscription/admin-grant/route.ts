import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import { adminGrantUnlimited } from "@/lib/services/subscription/subscription.service";
import { ManagedUserError } from "@/lib/services/subscription/managed-user.service";
import { adminGrantSchema } from "@/lib/validators/subscription.validator";
import { ok, errors, error as errorResponse } from "@/lib/utils/response";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const parsed = adminGrantSchema.safeParse(body ?? {});
    if (!parsed.success) {
        return errors.validationFailed(parsed.error.issues[0]?.message ?? "입력을 확인해주세요");
    }

    try {
        const ip = req.headers.get("cf-connecting-ip") ?? undefined;
        const result = await adminGrantUnlimited(auth.userId, id, parsed.data, { db }, { ip });
        return ok(result);
    } catch (err) {
        if (err instanceof ManagedUserError) return errorResponse(err.code, err.message, err.status);
        console.error("adminGrant failed", err);
        return errors.internal();
    }
}
