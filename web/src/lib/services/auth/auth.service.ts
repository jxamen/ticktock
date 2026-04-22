import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { users, passwordCredentials, auditLogs } from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "@/lib/utils/password";
import { signJwt } from "@/lib/utils/jwt";
import { generateUlid } from "@/lib/utils/ulid";
import type { SignupInput, LoginInput, ChangePasswordInput } from "@/lib/validators/auth.validator";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 10 * 60 * 1000;

type AuthDeps = {
    db: Database;
    kv: KVNamespace;
    jwtSecret: string;
};

export class AuthError extends Error {
    constructor(public code: string, message: string, public status = 400) {
        super(message);
    }
}

export async function signup(input: SignupInput, deps: AuthDeps, meta: { ip?: string }) {
    const { db } = deps;
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).get();
    if (existing) throw new AuthError("EMAIL_TAKEN", "이미 사용 중인 이메일입니다", 409);

    const now = new Date().toISOString();
    const userId = generateUlid();
    const passwordHash = await hashPassword(input.password);

    await db.batch([
        db.insert(users).values({
            id: userId,
            email: input.email,
            displayName: input.displayName,
            phone: input.phone || null,
            isActive: true,
            createdAt: now,
            updatedAt: now,
        }),
        db.insert(passwordCredentials).values({
            userId,
            passwordHash,
            failedAttempts: 0,
            updatedAt: now,
        }),
        db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId: userId,
            eventCode: "user.signup",
            targetType: "user",
            targetId: userId,
            ip: meta.ip,
            createdAt: now,
        }),
    ]);

    const { token, jti, exp } = await signJwt(
        { sub: userId, email: input.email },
        deps.jwtSecret,
        "access"
    );

    return { userId, email: input.email, displayName: input.displayName, token, jti, exp };
}

export async function login(input: LoginInput, deps: AuthDeps, meta: { ip?: string }) {
    const { db } = deps;
    const row = await db
        .select({
            userId: users.id,
            email: users.email,
            displayName: users.displayName,
            isActive: users.isActive,
            hash: passwordCredentials.passwordHash,
            failed: passwordCredentials.failedAttempts,
            lockedUntil: passwordCredentials.lockedUntil,
        })
        .from(users)
        .innerJoin(passwordCredentials, eq(users.id, passwordCredentials.userId))
        .where(eq(users.email, input.email))
        .get();

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    // 존재하지 않아도 timing attack 방지 — 비밀번호 검증 수행 시간 맞추기
    if (!row) {
        await verifyPassword("placeholder", "0000000000000000:00000000000000000000000000000000");
        await recordLoginFail(deps, null, input.email, meta.ip);
        throw new AuthError("INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다", 401);
    }

    if (!row.isActive) {
        throw new AuthError("ACCOUNT_DISABLED", "비활성화된 계정입니다", 403);
    }

    if (row.lockedUntil && new Date(row.lockedUntil).getTime() > nowMs) {
        throw new AuthError("ACCOUNT_LOCKED", "계정이 일시적으로 잠겼습니다. 잠시 후 다시 시도해주세요", 429);
    }

    const ok = await verifyPassword(input.password, row.hash);
    if (!ok) {
        const nextFailed = row.failed + 1;
        const shouldLock = nextFailed >= MAX_FAILED_ATTEMPTS;
        await db
            .update(passwordCredentials)
            .set({
                failedAttempts: nextFailed,
                lockedUntil: shouldLock ? new Date(nowMs + LOCK_DURATION_MS).toISOString() : null,
                updatedAt: nowIso,
            })
            .where(eq(passwordCredentials.userId, row.userId));
        await recordLoginFail(deps, row.userId, input.email, meta.ip);
        if (shouldLock) {
            throw new AuthError("ACCOUNT_LOCKED", "계정이 잠겼습니다. 10분 후 다시 시도해주세요", 429);
        }
        throw new AuthError("INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다", 401);
    }

    // 성공 — failed 카운터 리셋
    await db
        .update(passwordCredentials)
        .set({ failedAttempts: 0, lockedUntil: null, updatedAt: nowIso })
        .where(eq(passwordCredentials.userId, row.userId));

    await db.insert(auditLogs).values({
        id: generateUlid(),
        actorUserId: row.userId,
        eventCode: "user.login.success",
        targetType: "user",
        targetId: row.userId,
        ip: meta.ip,
        createdAt: nowIso,
    });

    const { token, jti, exp } = await signJwt(
        { sub: row.userId, email: row.email },
        deps.jwtSecret,
        "access"
    );

    return { userId: row.userId, email: row.email, displayName: row.displayName, token, jti, exp };
}

export async function logout(jti: string, expSec: number, deps: AuthDeps) {
    const remaining = Math.max(0, expSec - Math.floor(Date.now() / 1000));
    if (remaining > 0) {
        await deps.kv.put(`session:blacklist:${jti}`, "1", { expirationTtl: remaining });
    }
}

export async function changePassword(
    userId: string,
    input: ChangePasswordInput,
    deps: AuthDeps,
    meta: { ip?: string; currentJti?: string }
) {
    const { db } = deps;
    const row = await db
        .select({ hash: passwordCredentials.passwordHash })
        .from(passwordCredentials)
        .where(eq(passwordCredentials.userId, userId))
        .get();
    if (!row) throw new AuthError("NOT_FOUND", "계정을 찾을 수 없습니다", 404);

    const ok = await verifyPassword(input.currentPassword, row.hash);
    if (!ok) throw new AuthError("INVALID_CREDENTIALS", "현재 비밀번호가 일치하지 않습니다", 401);

    const newHash = await hashPassword(input.newPassword);
    const now = new Date().toISOString();

    await db.batch([
        db
            .update(passwordCredentials)
            .set({ passwordHash: newHash, failedAttempts: 0, lockedUntil: null, updatedAt: now })
            .where(eq(passwordCredentials.userId, userId)),
        db.insert(auditLogs).values({
            id: generateUlid(),
            actorUserId: userId,
            eventCode: "user.password_change",
            targetType: "user",
            targetId: userId,
            ip: meta.ip,
            createdAt: now,
        }),
    ]);

    // 현재 세션 이외의 모든 jti 를 blacklist 하려면 jti 목록을 별도 저장해야 하지만
    // 최소 구현에서는 현재 세션 제외 → 현재 jti 는 유지, 다른 디바이스는 재로그인 필요.
    // 간단화 위해 현재 jti 만 blacklist 하지 않고 다른 세션은 refresh 시 끊기도록 한다.
    return { ok: true };
}

export async function getMe(userId: string, deps: AuthDeps) {
    const row = await deps.db
        .select({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
            phone: users.phone,
            createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .get();
    if (!row) throw new AuthError("NOT_FOUND", "계정을 찾을 수 없습니다", 404);
    return row;
}

async function recordLoginFail(
    deps: AuthDeps,
    actorUserId: string | null,
    email: string,
    ip: string | undefined
) {
    const now = new Date().toISOString();
    await deps.db.insert(auditLogs).values({
        id: generateUlid(),
        actorUserId,
        eventCode: "user.login.fail",
        targetType: "user",
        targetId: actorUserId ?? undefined,
        metaJson: JSON.stringify({ email }),
        ip,
        createdAt: now,
    });
}
