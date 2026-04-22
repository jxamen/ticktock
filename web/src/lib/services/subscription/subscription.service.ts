import { desc, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
    auditLogs,
    managedUsers,
    subscriptionLedger,
    users,
} from "@/lib/db/schema";
import { generateUlid } from "@/lib/utils/ulid";
import type {
    AdminGrantInput,
    ExtendSubscriptionInput,
} from "@/lib/validators/subscription.validator";
import { assertDeviceOwner, assertDeviceViewer, ManagedUserError } from "./managed-user.service";

/** 무제한 만료 센티넬 — 2099년 말 */
const UNLIMITED_EXPIRES_AT = "2099-12-31T23:59:59.999Z";

type Deps = { db: Database };

/** 월 구독 연장 (1/3/12 개월) */
export async function extendSubscription(
    actorUserId: string,
    managedUserId: string,
    input: ExtendSubscriptionInput,
    deps: Deps,
    meta: { ip?: string },
) {
    const { db } = deps;

    const mu = await getManagedUserRow(db, managedUserId);
    await assertDeviceOwner(actorUserId, mu.deviceId, deps);

    const now = new Date();
    const nowIso = now.toISOString();
    const base = chooseBase(mu.subscriptionExpiresAt, now);
    const newExpiry = addMonths(base, input.months);
    const newExpiryIso = newExpiry.toISOString();

    const ledgerId = generateUlid();
    await db.batch([
        db
            .update(managedUsers)
            .set({
                subscriptionStatus: "active",
                subscriptionExpiresAt: newExpiryIso,
                updatedAt: nowIso,
            })
            .where(eq(managedUsers.id, managedUserId)),
        db.insert(subscriptionLedger).values({
            id: ledgerId,
            managedUserId,
            action: "extend",
            months: input.months,
            effectiveFrom: base.toISOString(),
            effectiveUntil: newExpiryIso,
            amountKrw: input.amountKrw,
            paymentRef: null,
            actorUserId,
            note: input.note ?? null,
            createdAt: nowIso,
        }),
        db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId,
            eventCode: "subscription.extend",
            targetType: "managed_user",
            targetId: managedUserId,
            metaJson: JSON.stringify({
                months: input.months,
                amountKrw: input.amountKrw,
                effectiveUntil: newExpiryIso,
            }),
            ip: meta.ip,
            createdAt: nowIso,
        }),
    ]);

    return { ledgerId, expiresAt: newExpiryIso };
}

/** 무제한 부여 — 태훈님 본인 테스트 용, 관리자 grant */
export async function adminGrantUnlimited(
    actorUserId: string,
    managedUserId: string,
    input: AdminGrantInput,
    deps: Deps,
    meta: { ip?: string },
) {
    const { db } = deps;

    const mu = await getManagedUserRow(db, managedUserId);
    await assertDeviceOwner(actorUserId, mu.deviceId, deps);

    const nowIso = new Date().toISOString();
    const ledgerId = generateUlid();

    await db.batch([
        db
            .update(managedUsers)
            .set({
                subscriptionStatus: "active",
                subscriptionExpiresAt: UNLIMITED_EXPIRES_AT,
                updatedAt: nowIso,
            })
            .where(eq(managedUsers.id, managedUserId)),
        db.insert(subscriptionLedger).values({
            id: ledgerId,
            managedUserId,
            action: "admin_grant",
            months: null,
            effectiveFrom: nowIso,
            effectiveUntil: UNLIMITED_EXPIRES_AT,
            amountKrw: 0,
            paymentRef: null,
            actorUserId,
            note: input.note ?? "무제한 부여",
            createdAt: nowIso,
        }),
        db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId,
            eventCode: "subscription.admin_grant",
            targetType: "managed_user",
            targetId: managedUserId,
            metaJson: JSON.stringify({ effectiveUntil: UNLIMITED_EXPIRES_AT }),
            ip: meta.ip,
            createdAt: nowIso,
        }),
    ]);

    return { ledgerId, expiresAt: UNLIMITED_EXPIRES_AT };
}

/** 구독 취소 — 즉시 만료 */
export async function revokeSubscription(
    actorUserId: string,
    managedUserId: string,
    deps: Deps,
    meta: { ip?: string; note?: string },
) {
    const { db } = deps;

    const mu = await getManagedUserRow(db, managedUserId);
    await assertDeviceOwner(actorUserId, mu.deviceId, deps);

    const nowIso = new Date().toISOString();
    const ledgerId = generateUlid();

    await db.batch([
        db
            .update(managedUsers)
            .set({
                subscriptionStatus: "expired",
                subscriptionExpiresAt: nowIso,
                updatedAt: nowIso,
            })
            .where(eq(managedUsers.id, managedUserId)),
        db.insert(subscriptionLedger).values({
            id: ledgerId,
            managedUserId,
            action: "revoke",
            months: null,
            effectiveFrom: nowIso,
            effectiveUntil: nowIso,
            amountKrw: 0,
            paymentRef: null,
            actorUserId,
            note: meta.note ?? null,
            createdAt: nowIso,
        }),
        db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId,
            eventCode: "subscription.revoke",
            targetType: "managed_user",
            targetId: managedUserId,
            metaJson: JSON.stringify({ previousExpiresAt: mu.subscriptionExpiresAt }),
            ip: meta.ip,
            createdAt: nowIso,
        }),
    ]);

    return { ledgerId };
}

/** 이 managed_user 의 구독 이력 (최신 순) */
export async function listSubscriptionLedger(
    actorUserId: string,
    managedUserId: string,
    deps: Deps,
) {
    const mu = await getManagedUserRow(deps.db, managedUserId);
    await assertDeviceViewer(actorUserId, mu.deviceId, deps);

    return deps.db
        .select({
            id: subscriptionLedger.id,
            action: subscriptionLedger.action,
            months: subscriptionLedger.months,
            effectiveFrom: subscriptionLedger.effectiveFrom,
            effectiveUntil: subscriptionLedger.effectiveUntil,
            amountKrw: subscriptionLedger.amountKrw,
            note: subscriptionLedger.note,
            actorEmail: users.email,
            actorDisplayName: users.displayName,
            createdAt: subscriptionLedger.createdAt,
        })
        .from(subscriptionLedger)
        .innerJoin(users, eq(subscriptionLedger.actorUserId, users.id))
        .where(eq(subscriptionLedger.managedUserId, managedUserId))
        .orderBy(desc(subscriptionLedger.createdAt))
        .all();
}

// ─── 내부 헬퍼 ───

async function getManagedUserRow(db: Database, managedUserId: string) {
    const row = await db
        .select()
        .from(managedUsers)
        .where(eq(managedUsers.id, managedUserId))
        .get();
    if (!row || !row.isActive) {
        throw new ManagedUserError("NOT_FOUND", "자녀 계정을 찾을 수 없습니다", 404);
    }
    return row;
}

function chooseBase(currentExpiresAt: string | null, now: Date): Date {
    if (!currentExpiresAt) return now;
    const current = new Date(currentExpiresAt);
    return current > now ? current : now;
}

/** 달력 기준 +N 개월. 말일 롤오버는 JS Date 기본 동작(overflow) 수용. */
function addMonths(base: Date, months: number): Date {
    const result = new Date(base);
    result.setMonth(result.getMonth() + months);
    return result;
}

export { UNLIMITED_EXPIRES_AT };
