import { z } from "zod";

export const setSeatLimitSchema = z.object({
    seatLimit: z.number().int().min(1).max(100),
});

export type SetSeatLimitInput = z.infer<typeof setSeatLimitSchema>;
