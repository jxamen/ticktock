import { sqliteTable, text, integer, unique, index } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { devices } from "./devices";

export const managedUsers = sqliteTable(
    "managed_users",
    {
        id: text("id").primaryKey(),
        deviceId: text("device_id").notNull().references(() => devices.id),
        windowsUsername: text("windows_username").notNull(),
        displayName: text("display_name").notNull(),
        subscriptionStatus: text("subscription_status", { enum: ["active", "expired"] })
            .notNull()
            .default("expired"),
        subscriptionExpiresAt: text("subscription_expires_at"),
        isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    (t) => ({
        deviceUsernameUnique: unique("uq_mu_device_username").on(t.deviceId, t.windowsUsername),
        deviceIdx: index("idx_mu_device").on(t.deviceId),
        expiresIdx: index("idx_mu_expires").on(t.subscriptionExpiresAt),
        activeIdx: index("idx_mu_active").on(t.isActive),
    }),
);

export const subscriptionLedger = sqliteTable(
    "subscription_ledger",
    {
        id: text("id").primaryKey(),
        managedUserId: text("managed_user_id").notNull().references(() => managedUsers.id),
        action: text("action", { enum: ["extend", "admin_grant", "revoke"] }).notNull(),
        months: integer("months"),
        effectiveFrom: text("effective_from").notNull(),
        effectiveUntil: text("effective_until").notNull(),
        amountKrw: integer("amount_krw").notNull().default(0),
        paymentRef: text("payment_ref"),
        actorUserId: text("actor_user_id").notNull().references(() => users.id),
        note: text("note"),
        createdAt: text("created_at").notNull(),
    },
    (t) => ({
        managedUserIdx: index("idx_sl_managed_user").on(t.managedUserId),
        createdIdx: index("idx_sl_created").on(t.createdAt),
        actorIdx: index("idx_sl_actor").on(t.actorUserId),
    }),
);
