import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
    devicePermissions,
    devices,
    managedUsers,
    subscriptionLedger,
    auditLogs,
} from "@/lib/db/schema";
import { generateUlid } from "@/lib/utils/ulid";
import type { CreateManagedUserInput } from "@/lib/validators/subscription.validator";
import { assertSeatAvailable } from "@/lib/services/plan/plan.service";

export class ManagedUserError extends Error {
    constructor(public code: string, message: string, public status = 400) {
        super(message);
    }
}

type Deps = { db: Database };

/** actor 가 해당 device 의 owner 인지 검증 */
export async function assertDeviceOwner(actorUserId: string, deviceId: string, deps: Deps) {
    const perm = await deps.db
        .select({ role: devicePermissions.role })
        .from(devicePermissions)
        .where(
            and(
                eq(devicePermissions.userId, actorUserId),
                eq(devicePermissions.deviceId, deviceId),
            ),
        )
        .get();
    if (!perm) {
        throw new ManagedUserError("FORBIDDEN", "해당 디바이스에 접근 권한이 없습니다", 403);
    }
    if (perm.role !== "owner") {
        throw new ManagedUserError("FORBIDDEN", "owner 권한이 필요합니다", 403);
    }
}

/** actor 가 해당 device 를 조회할 수 있는지 (owner | viewer) */
export async function assertDeviceViewer(actorUserId: string, deviceId: string, deps: Deps) {
    const perm = await deps.db
        .select({ role: devicePermissions.role })
        .from(devicePermissions)
        .where(
            and(
                eq(devicePermissions.userId, actorUserId),
                eq(devicePermissions.deviceId, deviceId),
            ),
        )
        .get();
    if (!perm) {
        throw new ManagedUserError("FORBIDDEN", "해당 디바이스에 접근 권한이 없습니다", 403);
    }
}

/** 자녀 Windows 계정 추가 — 구독은 시작 안 됨 (expired) */
export async function createManagedUser(
    actorUserId: string,
    deviceId: string,
    input: CreateManagedUserInput,
    deps: Deps,
    meta: { ip?: string },
) {
    const { db } = deps;
    await assertDeviceOwner(actorUserId, deviceId, deps);

    // 중복 확인
    const existing = await db
        .select({ id: managedUsers.id, isActive: managedUsers.isActive })
        .from(managedUsers)
        .where(
            and(
                eq(managedUsers.deviceId, deviceId),
                eq(managedUsers.windowsUsername, input.windowsUsername),
            ),
        )
        .get();

    // seat 한도 검증 (재활성화도 seat 소비이므로 동일 체크)
    if (!existing || !existing.isActive) {
        await assertSeatAvailable(actorUserId, deps);
    }

    const now = new Date().toISOString();

    if (existing) {
        if (existing.isActive) {
            throw new ManagedUserError(
                "USERNAME_TAKEN",
                "이미 등록된 Windows 사용자명입니다",
                409,
            );
        }
        // 소프트 삭제된 이전 항목 재활성화 (이름/구독은 새로)
        await db.batch([
            db
                .update(managedUsers)
                .set({
                    displayName: input.displayName,
                    isActive: true,
                    subscriptionStatus: "expired",
                    subscriptionExpiresAt: null,
                    updatedAt: now,
                })
                .where(eq(managedUsers.id, existing.id)),
            db.insert(auditLogs).values({
                id: generateUlid(),
                actorUserId,
                eventCode: "managed_user.reactivate",
                targetType: "managed_user",
                targetId: existing.id,
                metaJson: JSON.stringify({ deviceId }),
                ip: meta.ip,
                createdAt: now,
            }),
        ]);
        return { id: existing.id, reactivated: true };
    }

    const id = generateUlid();
    await db.batch([
        db.insert(managedUsers).values({
            id,
            deviceId,
            windowsUsername: input.windowsUsername,
            displayName: input.displayName,
            subscriptionStatus: "expired",
            subscriptionExpiresAt: null,
            isActive: true,
            createdAt: now,
            updatedAt: now,
        }),
        db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId,
            eventCode: "managed_user.create",
            targetType: "managed_user",
            targetId: id,
            metaJson: JSON.stringify({ deviceId, windowsUsername: input.windowsUsername }),
            ip: meta.ip,
            createdAt: now,
        }),
    ]);
    return { id, reactivated: false };
}

/** 자녀 계정 목록 (소프트삭제 제외) + 파생 status 포함 */
export async function listManagedUsers(actorUserId: string, deviceId: string, deps: Deps) {
    await assertDeviceViewer(actorUserId, deviceId, deps);

    const rows = await deps.db
        .select()
        .from(managedUsers)
        .where(
            and(
                eq(managedUsers.deviceId, deviceId),
                eq(managedUsers.isActive, true),
            ),
        )
        .all();

    return rows.map((r) => ({
        ...r,
        subscriptionStatus: deriveStatus(r.subscriptionExpiresAt),
    }));
}

/** 단건 조회 */
export async function getManagedUser(actorUserId: string, managedUserId: string, deps: Deps) {
    const row = await deps.db
        .select()
        .from(managedUsers)
        .where(eq(managedUsers.id, managedUserId))
        .get();
    if (!row || !row.isActive) {
        throw new ManagedUserError("NOT_FOUND", "자녀 계정을 찾을 수 없습니다", 404);
    }
    await assertDeviceViewer(actorUserId, row.deviceId, deps);
    return { ...row, subscriptionStatus: deriveStatus(row.subscriptionExpiresAt) };
}

/** 자녀 계정 삭제 (소프트) — 구독도 즉시 취소 기록 */
export async function removeManagedUser(
    actorUserId: string,
    managedUserId: string,
    deps: Deps,
    meta: { ip?: string },
) {
    const { db } = deps;
    const row = await db
        .select()
        .from(managedUsers)
        .where(eq(managedUsers.id, managedUserId))
        .get();
    if (!row || !row.isActive) {
        throw new ManagedUserError("NOT_FOUND", "자녀 계정을 찾을 수 없습니다", 404);
    }
    await assertDeviceOwner(actorUserId, row.deviceId, deps);

    const now = new Date().toISOString();
    const updateMu = db
        .update(managedUsers)
        .set({ isActive: false, subscriptionStatus: "expired", updatedAt: now })
        .where(eq(managedUsers.id, managedUserId));
    const auditInsert = db.insert(auditLogs).values({
        id: generateUlid(),
        actorUserId,
        eventCode: "managed_user.remove",
        targetType: "managed_user",
        targetId: managedUserId,
        metaJson: JSON.stringify({ deviceId: row.deviceId }),
        ip: meta.ip,
        createdAt: now,
    });

    const hadActive =
        row.subscriptionExpiresAt && new Date(row.subscriptionExpiresAt) > new Date();

    if (hadActive) {
        const revokeLedger = db.insert(subscriptionLedger).values({
            id: generateUlid(),
            managedUserId,
            action: "revoke",
            months: null,
            effectiveFrom: now,
            effectiveUntil: now,
            amountKrw: 0,
            paymentRef: null,
            actorUserId,
            note: "계정 삭제로 인한 자동 취소",
            createdAt: now,
        });
        await db.batch([updateMu, auditInsert, revokeLedger]);
    } else {
        await db.batch([updateMu, auditInsert]);
    }
    return { ok: true };
}

/** 디바이스 상세 + 자녀 계정 집계 (목록 페이지용) */
export async function listDevicesWithSummary(actorUserId: string, deps: Deps) {
    const myDevices = await deps.db
        .select({
            id: devices.id,
            name: devices.name,
            timezone: devices.timezone,
            agentVersion: devices.agentVersion,
            lastSeenAt: devices.lastSeenAt,
            isActive: devices.isActive,
            createdAt: devices.createdAt,
            role: devicePermissions.role,
        })
        .from(devices)
        .innerJoin(devicePermissions, eq(devices.id, devicePermissions.deviceId))
        .where(
            and(
                eq(devicePermissions.userId, actorUserId),
                eq(devices.isActive, true),
            ),
        )
        .all();

    if (myDevices.length === 0) return [];

    const ids = myDevices.map((d) => d.id);
    const allManagedUsers = await deps.db
        .select({
            deviceId: managedUsers.deviceId,
            expiresAt: managedUsers.subscriptionExpiresAt,
        })
        .from(managedUsers)
        .where(eq(managedUsers.isActive, true))
        .all();

    const perDevice = new Map<string, { total: number; active: number }>();
    for (const d of ids) perDevice.set(d, { total: 0, active: 0 });
    for (const mu of allManagedUsers) {
        const bucket = perDevice.get(mu.deviceId);
        if (!bucket) continue;
        bucket.total += 1;
        if (deriveStatus(mu.expiresAt) === "active") bucket.active += 1;
    }

    return myDevices.map((d) => ({
        ...d,
        managedUsersTotal: perDevice.get(d.id)?.total ?? 0,
        managedUsersActive: perDevice.get(d.id)?.active ?? 0,
    }));
}

/** expires_at 기반으로 active/expired 를 일관되게 파생 */
export function deriveStatus(expiresAt: string | null): "active" | "expired" {
    if (!expiresAt) return "expired";
    return new Date(expiresAt) > new Date() ? "active" : "expired";
}
