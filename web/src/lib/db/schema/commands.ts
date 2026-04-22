import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { devices } from "./devices";
import { managedUsers } from "./subscription";

export const commandsIssued = sqliteTable(
    "commands_issued",
    {
        id: text("id").primaryKey(),
        managedUserId: text("managed_user_id").notNull().references(() => managedUsers.id),
        deviceId: text("device_id").notNull().references(() => devices.id),
        type: text("type", {
            enum: ["lock", "unlock", "set_pin", "grant_bonus"],
        }).notNull(),
        payloadJson: text("payload_json"),
        status: text("status", {
            enum: ["pending", "delivered", "consumed", "failed", "canceled"],
        })
            .notNull()
            .default("pending"),
        failureReason: text("failure_reason"),
        issuedBy: text("issued_by").notNull().references(() => users.id),
        issuedAt: text("issued_at").notNull(),
        deliveredAt: text("delivered_at"),
        consumedAt: text("consumed_at"),
        createdAt: text("created_at").notNull(),
    },
    (t) => ({
        managedUserIdx: index("idx_ci_managed_user").on(t.managedUserId),
        deviceIdx: index("idx_ci_device").on(t.deviceId),
        statusIdx: index("idx_ci_status").on(t.status),
        issuedAtIdx: index("idx_ci_issued_at").on(t.issuedAt),
    }),
);
