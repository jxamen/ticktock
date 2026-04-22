import { z } from "zod";

export const lockCommandSchema = z.object({
    type: z.literal("lock"),
    note: z.string().max(200).optional(),
});

export const unlockCommandSchema = z.object({
    type: z.literal("unlock"),
    note: z.string().max(200).optional(),
});

export const setPinCommandSchema = z.object({
    type: z.literal("set_pin"),
    pin: z
        .string()
        .regex(/^[0-9]{4,8}$/, "PIN 은 4~8자리 숫자여야 합니다"),
});

export const grantBonusCommandSchema = z.object({
    type: z.literal("grant_bonus"),
    minutes: z.number().int().positive().max(24 * 60),
    note: z.string().max(200).optional(),
});

export const issueCommandSchema = z.discriminatedUnion("type", [
    lockCommandSchema,
    unlockCommandSchema,
    setPinCommandSchema,
    grantBonusCommandSchema,
]);

export type IssueCommandInput = z.infer<typeof issueCommandSchema>;
