import { z } from "zod";

export const signupSchema = z.object({
    email: z.string().email(),
    password: z
        .string()
        .min(8, "비밀번호는 8자 이상이어야 합니다")
        .regex(/[0-9]/, "숫자를 포함해야 합니다")
        .regex(/[a-zA-Z]/, "영문을 포함해야 합니다"),
    displayName: z.string().min(1).max(50),
    phone: z.string().regex(/^[0-9+\-\s]{0,20}$/).optional().or(z.literal("")),
});

export const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});

export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z
        .string()
        .min(8)
        .regex(/[0-9]/)
        .regex(/[a-zA-Z]/),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
