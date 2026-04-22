import { z } from "zod";

export const updateProfileSchema = z.object({
    displayName: z.string().min(1).max(50).optional(),
    phone: z.string().regex(/^[0-9+\-\s]{0,20}$/).optional().or(z.literal("")),
});

export const grantPermissionSchema = z.object({
    email: z.string().email(),
    role: z.enum(["owner", "viewer"]),
});

export const searchUserSchema = z.object({
    email: z.string().email(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type GrantPermissionInput = z.infer<typeof grantPermissionSchema>;
