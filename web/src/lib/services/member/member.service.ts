import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { users, devicePermissions, auditLogs } from "@/lib/db/schema";
import { devices } from "@/lib/db/schema/devices";
import { generateUlid } from "@/lib/utils/ulid";
import type { UpdateProfileInput, GrantPermissionInput } from "@/lib/validators/member.validator";

export class MemberError extends Error {
    constructor(public code: string, message: string, public status = 400) {
        super(message);
    }
}

type Deps = { db: Database };

/** 내 프로필 업데이트 */
export async function updateProfile(userId: string, input: UpdateProfileInput, deps: Deps) {
    const now = new Date().toISOString();
    const values: Partial<typeof users.$inferInsert> = { updatedAt: now };
    if (input.displayName !== undefined) values.displayName = input.displayName;
    if (input.phone !== undefined) values.phone = input.phone || null;

    await deps.db.update(users).set(values).where(eq(users.id, userId));
    return { ok: true };
}

/** 이메일로 사용자 검색 (초대 자동완성용) — 정확 일치만 노출 */
export async function searchUserByEmail(email: string, deps: Deps) {
    const row = await deps.db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(and(eq(users.email, email), eq(users.isActive, true)))
        .get();
    return row ?? null;
}

/** 내가 접근 가능한 모든 디바이스 + 해당 디바이스의 다른 owner/viewer 들 */
export async function listMembersByDevice(userId: string, deps: Deps) {
    // 1. 내 device_permissions
    const myPerms = await deps.db
        .select({
            deviceId: devicePermissions.deviceId,
            role: devicePermissions.role,
        })
        .from(devicePermissions)
        .where(eq(devicePermissions.userId, userId))
        .all();

    if (myPerms.length === 0) return [];

    const deviceIds = myPerms.map((p) => p.deviceId);

    // 2. 디바이스 메타 + 해당 디바이스의 모든 permission + user 정보
    const deviceRows = await deps.db
        .select()
        .from(devices)
        .where(and(inArray(devices.id, deviceIds), eq(devices.isActive, true)))
        .all();

    const allPerms = await deps.db
        .select({
            id: devicePermissions.id,
            deviceId: devicePermissions.deviceId,
            userId: devicePermissions.userId,
            role: devicePermissions.role,
            createdAt: devicePermissions.createdAt,
            userEmail: users.email,
            userDisplayName: users.displayName,
        })
        .from(devicePermissions)
        .innerJoin(users, eq(devicePermissions.userId, users.id))
        .where(inArray(devicePermissions.deviceId, deviceIds))
        .all();

    return deviceRows.map((d) => ({
        device: {
            id: d.id,
            name: d.name,
            timezone: d.timezone,
            lastSeenAt: d.lastSeenAt,
        },
        myRole: myPerms.find((p) => p.deviceId === d.id)?.role ?? "viewer",
        members: allPerms
            .filter((p) => p.deviceId === d.id)
            .map((p) => ({
                permissionId: p.id,
                userId: p.userId,
                email: p.userEmail,
                displayName: p.userDisplayName,
                role: p.role,
                createdAt: p.createdAt,
            })),
    }));
}

/** 디바이스에 권한 부여 (기존 사용자만 — 초대 링크 발송은 추후) */
export async function grantPermission(
    actorUserId: string,
    deviceId: string,
    input: GrantPermissionInput,
    deps: Deps,
    meta: { ip?: string }
) {
    const { db } = deps;

    // 1. actor 가 해당 디바이스의 owner 인지 확인
    const actorPerm = await db
        .select({ role: devicePermissions.role })
        .from(devicePermissions)
        .where(and(eq(devicePermissions.userId, actorUserId), eq(devicePermissions.deviceId, deviceId)))
        .get();
    if (!actorPerm || actorPerm.role !== "owner") {
        throw new MemberError("FORBIDDEN", "owner 권한이 필요합니다", 403);
    }

    // 2. 초대 대상 사용자 조회
    const target = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).get();
    if (!target) {
        throw new MemberError("USER_NOT_FOUND", "해당 이메일로 가입한 사용자가 없습니다. 상대방이 먼저 회원가입해야 합니다", 404);
    }

    // 3. 이미 권한이 있는지 확인
    const existing = await db
        .select({ id: devicePermissions.id, role: devicePermissions.role })
        .from(devicePermissions)
        .where(and(eq(devicePermissions.userId, target.id), eq(devicePermissions.deviceId, deviceId)))
        .get();

    const now = new Date().toISOString();

    if (existing) {
        if (existing.role === input.role) {
            return { ok: true, permissionId: existing.id, unchanged: true };
        }
        // role 변경
        await db
            .update(devicePermissions)
            .set({ role: input.role })
            .where(eq(devicePermissions.id, existing.id));
        await db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId,
            eventCode: "device.permission_update",
            targetType: "device_permission",
            targetId: existing.id,
            metaJson: JSON.stringify({ targetUserId: target.id, deviceId, from: existing.role, to: input.role }),
            ip: meta.ip,
            createdAt: now,
        });
        return { ok: true, permissionId: existing.id };
    }

    // 4. 신규 권한 INSERT
    const permissionId = generateUlid();
    await db.batch([
        db.insert(devicePermissions).values({
            id: permissionId,
            userId: target.id,
            deviceId,
            role: input.role,
            createdAt: now,
        }),
        db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId,
            eventCode: "device.permission_grant",
            targetType: "device_permission",
            targetId: permissionId,
            metaJson: JSON.stringify({ targetUserId: target.id, deviceId, role: input.role }),
            ip: meta.ip,
            createdAt: now,
        }),
    ]);

    return { ok: true, permissionId };
}

/** 권한 제거 (마지막 owner 보호) */
export async function revokePermission(
    actorUserId: string,
    deviceId: string,
    permissionId: string,
    deps: Deps,
    meta: { ip?: string }
) {
    const { db } = deps;

    // 1. actor 가 owner 인지 확인
    const actorPerm = await db
        .select({ role: devicePermissions.role })
        .from(devicePermissions)
        .where(and(eq(devicePermissions.userId, actorUserId), eq(devicePermissions.deviceId, deviceId)))
        .get();
    if (!actorPerm || actorPerm.role !== "owner") {
        throw new MemberError("FORBIDDEN", "owner 권한이 필요합니다", 403);
    }

    // 2. 제거 대상 조회
    const target = await db
        .select()
        .from(devicePermissions)
        .where(and(eq(devicePermissions.id, permissionId), eq(devicePermissions.deviceId, deviceId)))
        .get();
    if (!target) {
        throw new MemberError("NOT_FOUND", "권한을 찾을 수 없습니다", 404);
    }

    // 3. 마지막 owner 보호
    if (target.role === "owner") {
        const ownerCount = await db
            .select({ id: devicePermissions.id })
            .from(devicePermissions)
            .where(and(eq(devicePermissions.deviceId, deviceId), eq(devicePermissions.role, "owner")))
            .all();
        if (ownerCount.length <= 1) {
            throw new MemberError("LAST_OWNER", "마지막 owner 는 제거할 수 없습니다", 400);
        }
    }

    const now = new Date().toISOString();
    await db.batch([
        db.delete(devicePermissions).where(eq(devicePermissions.id, permissionId)),
        db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId,
            eventCode: "device.permission_revoke",
            targetType: "device_permission",
            targetId: permissionId,
            metaJson: JSON.stringify({ targetUserId: target.userId, deviceId, role: target.role }),
            ip: meta.ip,
            createdAt: now,
        }),
    ]);

    return { ok: true };
}
