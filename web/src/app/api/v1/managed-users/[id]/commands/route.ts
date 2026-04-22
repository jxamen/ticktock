import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import {
    issueCommand,
    listRecentCommands,
} from "@/lib/services/command/command.service";
import { ManagedUserError } from "@/lib/services/subscription/managed-user.service";
import { issueCommandSchema } from "@/lib/validators/command.validator";
import { ok, errors, error as errorResponse } from "@/lib/utils/response";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;
    const { id } = await ctx.params;

    try {
        const rows = await listRecentCommands(auth.userId, id, { db });
        return ok(rows);
    } catch (err) {
        if (err instanceof ManagedUserError) return errorResponse(err.code, err.message, err.status);
        console.error("listRecentCommands failed", err);
        return errors.internal();
    }
}

export async function POST(req: NextRequest, ctx: Ctx) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const parsed = issueCommandSchema.safeParse(body);
    if (!parsed.success) {
        return errors.validationFailed(parsed.error.issues[0]?.message ?? "입력을 확인해주세요");
    }

    try {
        const ip = req.headers.get("cf-connecting-ip") ?? undefined;
        const result = await issueCommand(auth.userId, id, parsed.data, { db }, { ip });
        return ok(result, 201);
    } catch (err) {
        if (err instanceof ManagedUserError) return errorResponse(err.code, err.message, err.status);
        console.error("issueCommand failed", err);
        return errors.internal();
    }
}
