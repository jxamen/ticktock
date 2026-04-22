import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import {
    getManagedUser,
    removeManagedUser,
    ManagedUserError,
} from "@/lib/services/subscription/managed-user.service";
import { ok, errors, error as errorResponse } from "@/lib/utils/response";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;
    const { id } = await ctx.params;

    try {
        const row = await getManagedUser(auth.userId, id, { db });
        return ok(row);
    } catch (err) {
        if (err instanceof ManagedUserError) return errorResponse(err.code, err.message, err.status);
        console.error("getManagedUser failed", err);
        return errors.internal();
    }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;
    const { id } = await ctx.params;

    try {
        const ip = req.headers.get("cf-connecting-ip") ?? undefined;
        const result = await removeManagedUser(auth.userId, id, { db }, { ip });
        return ok(result);
    } catch (err) {
        if (err instanceof ManagedUserError) return errorResponse(err.code, err.message, err.status);
        console.error("removeManagedUser failed", err);
        return errors.internal();
    }
}
