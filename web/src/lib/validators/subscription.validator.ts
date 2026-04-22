import { z } from "zod";

/** 자녀 Windows 계정 생성 */
export const createManagedUserSchema = z.object({
    windowsUsername: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9._\-]+$/, "영문/숫자/._- 만 허용"),
    displayName: z.string().min(1).max(50),
});

/** 구독 연장 — 개월(1/3/12) 중 하나. 무제한은 별도 admin_grant API */
export const extendSubscriptionSchema = z.object({
    months: z.union([z.literal(1), z.literal(3), z.literal(12)]),
    amountKrw: z.number().int().nonnegative().default(0),
    note: z.string().max(500).optional(),
});

/** 무제한 부여 (관리자/태훈님 PC 용) */
export const adminGrantSchema = z.object({
    note: z.string().max(500).optional(),
});

export type CreateManagedUserInput = z.infer<typeof createManagedUserSchema>;
export type ExtendSubscriptionInput = z.infer<typeof extendSubscriptionSchema>;
export type AdminGrantInput = z.infer<typeof adminGrantSchema>;
