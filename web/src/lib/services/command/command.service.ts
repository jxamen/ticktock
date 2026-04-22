import { and, desc, eq, gt } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { auditLogs, commandsIssued, managedUsers, users } from "@/lib/db/schema";
import { generateUlid } from "@/lib/utils/ulid";
import type { IssueCommandInput } from "@/lib/validators/command.validator";
import {
    assertDeviceOwner,
    ManagedUserError,
} from "@/lib/services/subscription/managed-user.service";

type Deps = { db: Database };

const MAX_PER_MINUTE = 60;

/**
 * 명령 발행. D1 에 원장 기록 + (나중에 에이전트 연동 시) Firebase RTDB push.
 * 지금은 status='pending' 으로 기록만. 에이전트 브릿지 Workers 가 픽업해 RTDB 로 전달.
 */
export async function issueCommand(
    actorUserId: string,
    managedUserId: string,
    input: IssueCommandInput,
    deps: Deps,
    meta: { ip?: string },
) {
    const { db } = deps;

    const mu = await db
        .select({
            id: managedUsers.id,
            deviceId: managedUsers.deviceId,
            isActive: managedUsers.isActive,
            subscriptionExpiresAt: managedUsers.subscriptionExpiresAt,
        })
        .from(managedUsers)
        .where(eq(managedUsers.id, managedUserId))
        .get();
    if (!mu || !mu.isActive) {
        throw new ManagedUserError("NOT_FOUND", "자녀 계정을 찾을 수 없습니다", 404);
    }
    await assertDeviceOwner(actorUserId, mu.deviceId, deps);

    // 구독 만료 시 잠금·보너스 제외 명령 차단 (해제는 허용 — 부모가 상태 복구 가능)
    const expired =
        !mu.subscriptionExpiresAt || new Date(mu.subscriptionExpiresAt) <= new Date();
    if (expired && (input.type === "set_pin" || input.type === "grant_bonus")) {
        throw new ManagedUserError(
            "SUBSCRIPTION_EXPIRED",
            "구독이 만료되어 이 명령을 실행할 수 없습니다",
            402,
        );
    }

    // Rate limit — 같은 managed_user 에 대해 최근 1분 내 60건 초과 시 차단
    const recentCount = await countRecentCommands(db, managedUserId, 60_000);
    if (recentCount >= MAX_PER_MINUTE) {
        throw new ManagedUserError(
            "RATE_LIMITED",
            "명령이 너무 자주 발행되었습니다. 잠시 후 다시 시도해주세요",
            429,
        );
    }

    const nowIso = new Date().toISOString();
    const id = generateUlid();
    const payload = buildPayload(input);
    const metaForAudit = buildAuditMeta(input);

    await db.batch([
        db.insert(commandsIssued).values({
            id,
            managedUserId,
            deviceId: mu.deviceId,
            type: input.type,
            payloadJson: payload ? JSON.stringify(payload) : null,
            status: "pending",
            issuedBy: actorUserId,
            issuedAt: nowIso,
            createdAt: nowIso,
        }),
        db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId,
            eventCode: `command.${input.type}`,
            targetType: "managed_user",
            targetId: managedUserId,
            metaJson: JSON.stringify({ commandId: id, ...metaForAudit }),
            ip: meta.ip,
            createdAt: nowIso,
        }),
    ]);

    return { commandId: id, status: "pending" as const };
}

/** 최근 명령 이력 (카드에 보여줄 용) */
export async function listRecentCommands(
    actorUserId: string,
    managedUserId: string,
    deps: Deps,
    limit = 10,
) {
    const mu = await deps.db
        .select({ deviceId: managedUsers.deviceId, isActive: managedUsers.isActive })
        .from(managedUsers)
        .where(eq(managedUsers.id, managedUserId))
        .get();
    if (!mu || !mu.isActive) {
        throw new ManagedUserError("NOT_FOUND", "자녀 계정을 찾을 수 없습니다", 404);
    }
    await assertDeviceOwner(actorUserId, mu.deviceId, deps);

    return deps.db
        .select({
            id: commandsIssued.id,
            type: commandsIssued.type,
            status: commandsIssued.status,
            issuedAt: commandsIssued.issuedAt,
            deliveredAt: commandsIssued.deliveredAt,
            consumedAt: commandsIssued.consumedAt,
            failureReason: commandsIssued.failureReason,
            actorEmail: users.email,
            actorDisplayName: users.displayName,
        })
        .from(commandsIssued)
        .innerJoin(users, eq(commandsIssued.issuedBy, users.id))
        .where(eq(commandsIssued.managedUserId, managedUserId))
        .orderBy(desc(commandsIssued.issuedAt))
        .limit(limit)
        .all();
}

async function countRecentCommands(db: Database, managedUserId: string, windowMs: number) {
    const since = new Date(Date.now() - windowMs).toISOString();
    const rows = await db
        .select({ id: commandsIssued.id })
        .from(commandsIssued)
        .where(
            and(
                eq(commandsIssued.managedUserId, managedUserId),
                gt(commandsIssued.issuedAt, since),
            ),
        )
        .all();
    return rows.length;
}

function buildPayload(input: IssueCommandInput): Record<string, unknown> | null {
    switch (input.type) {
        case "lock":
        case "unlock":
            return input.note ? { note: input.note } : null;
        case "set_pin":
            return { pin: input.pin };
        case "grant_bonus":
            return { minutes: input.minutes, note: input.note };
    }
}

/** 감사 로그에는 PIN 평문을 남기지 않는다 */
function buildAuditMeta(input: IssueCommandInput): Record<string, unknown> {
    switch (input.type) {
        case "lock":
        case "unlock":
            return { note: input.note ?? null };
        case "set_pin":
            return { pinLength: input.pin.length };
        case "grant_bonus":
            return { minutes: input.minutes, note: input.note ?? null };
    }
}
