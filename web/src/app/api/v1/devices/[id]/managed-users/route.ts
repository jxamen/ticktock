import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import {
    createManagedUser,
    listManagedUsers,
    ManagedUserError,
} from "@/lib/services/subscription/managed-user.service";
import { PlanError } from "@/lib/services/plan/plan.service";
import { createManagedUserSchema } from "@/lib/validators/subscription.validator";
import { ok, errors, error as errorResponse } from "@/lib/utils/response";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;
    const { id: deviceId } = await ctx.params;

    try {
        const rows = await listManagedUsers(auth.userId, deviceId, { db });
        return ok(rows);
    } catch (err) {
        if (err instanceof ManagedUserError) return errorResponse(err.code, err.message, err.status);
        console.error("listManagedUsers failed", err);
        return errors.internal();
    }
}

export async function POST(req: NextRequest, ctx: Ctx) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;
    const { id: deviceId } = await ctx.params;

    const body = await req.json().catch(() => null);
    const parsed = createManagedUserSchema.safeParse(body);
    if (!parsed.success) {
        return errors.validationFailed(parsed.error.issues[0]?.message ?? "입력을 확인해주세요");
    }

    try {
        const ip = req.headers.get("cf-connecting-ip") ?? undefined;
        const result = await createManagedUser(
            auth.userId,
            deviceId,
            parsed.data,
            { db },
            { ip },
        );
        return ok(result, 201);
    } catch (err) {
        if (err instanceof ManagedUserError) return errorResponse(err.code, err.message, err.status);
        if (err instanceof PlanError) return errorResponse(err.code, err.message, err.status);
        console.error("createManagedUser failed", err);
        return errors.internal();
    }
}
