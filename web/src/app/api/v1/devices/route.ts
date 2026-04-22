import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { requireAuth } from "@/lib/middleware/auth";
import { listDevicesWithSummary } from "@/lib/services/subscription/managed-user.service";
import { ok, errors } from "@/lib/utils/response";

export async function GET(req: NextRequest) {
    const { db, env } = await getEnv();
    const auth = await requireAuth(req, env);
    if (auth instanceof Response) return auth;

    try {
        const rows = await listDevicesWithSummary(auth.userId, { db });
        return ok(rows);
    } catch (err) {
        console.error("listDevices failed", err);
        return errors.internal();
    }
}
