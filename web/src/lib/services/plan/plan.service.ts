import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
    auditLogs,
    devicePermissions,
    devices,
    managedUsers,
    users,
} from "@/lib/db/schema";
import { generateUlid } from "@/lib/utils/ulid";
import type { SetSeatLimitInput } from "@/lib/validators/plan.validator";

export class PlanError extends Error {
    constructor(public code: string, message: string, public status = 400) {
        super(message);
    }
}

type Deps = { db: Database };

/** 내 seat 현황: 한도 + 사용 중 활성 seat (managed_user 이름 포함) */
export async function getMySeats(userId: string, deps: Deps) {
    const user = await deps.db
        .select({ seatLimit: users.seatLimit })
        .from(users)
        .where(eq(users.id, userId))
        .get();
    if (!user) throw new PlanError("NOT_FOUND", "계정을 찾을 수 없습니다", 404);

    // 내가 owner 인 디바이스 아래의 활성 managed_user 전부 = 내가 점유 중인 seat
    const rows = await deps.db
        .select({
            id: managedUsers.id,
            deviceId: managedUsers.deviceId,
            deviceName: devices.name,
            windowsUsername: managedUsers.windowsUsername,
            displayName: managedUsers.displayName,
            subscriptionExpiresAt: managedUsers.subscriptionExpiresAt,
        })
        .from(managedUsers)
        .innerJoin(devices, eq(managedUsers.deviceId, devices.id))
        .innerJoin(devicePermissions, eq(devices.id, devicePermissions.deviceId))
        .where(
            and(
                eq(devicePermissions.userId, userId),
                eq(devicePermissions.role, "owner"),
                eq(managedUsers.isActive, true),
                eq(devices.isActive, true),
            ),
        )
        .all();

    const now = new Date();
    const seats = rows.map((r) => ({
        managedUserId: r.id,
        deviceId: r.deviceId,
        deviceName: r.deviceName,
        windowsUsername: r.windowsUsername,
        displayName: r.displayName,
        subscriptionActive:
            r.subscriptionExpiresAt !== null && new Date(r.subscriptionExpiresAt) > now,
    }));

    return {
        seatLimit: user.seatLimit,
        used: seats.length,
        available: Math.max(0, user.seatLimit - seats.length),
        seats,
    };
}

/** seat 한 자리를 더 점유할 수 있는지 확인. 초과하면 PlanError(409). */
export async function assertSeatAvailable(userId: string, deps: Deps) {
    const { seatLimit, used } = await getMySeats(userId, deps);
    if (used >= seatLimit) {
        throw new PlanError(
            "SEAT_LIMIT_EXCEEDED",
            `seat 한도(${seatLimit}) 를 모두 사용 중입니다. 기존 자녀 계정을 삭제하거나 한도를 늘려주세요`,
            409,
        );
    }
}

/** 내 seat 한도 설정 (본인만) */
export async function setMySeatLimit(
    userId: string,
    input: SetSeatLimitInput,
    deps: Deps,
    meta: { ip?: string },
) {
    const now = new Date().toISOString();
    // 현재 사용량보다 낮게 설정하는 것은 막지 않음 — 이미 점유 중인 seat 은 유지하되 추가 불가
    await deps.db.batch([
        deps.db
            .update(users)
            .set({ seatLimit: input.seatLimit, updatedAt: now })
            .where(eq(users.id, userId)),
        deps.db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId: userId,
            eventCode: "user.seat_limit_change",
            targetType: "user",
            targetId: userId,
            metaJson: JSON.stringify({ seatLimit: input.seatLimit }),
            ip: meta.ip,
            createdAt: now,
        }),
    ]);
    return { ok: true, seatLimit: input.seatLimit };
}
