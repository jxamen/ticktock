import { sqliteTable, text, integer, unique, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
    "users",
    {
        id: text("id").primaryKey(),
        email: text("email").notNull().unique(),
        displayName: text("display_name").notNull(),
        phone: text("phone"),
        firebaseUid: text("firebase_uid").unique(),
        seatLimit: integer("seat_limit").notNull().default(5),
        isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    (t) => ({
        emailIdx: index("idx_users_email").on(t.email),
        firebaseUidIdx: index("idx_users_firebase_uid").on(t.firebaseUid),
    })
);

export const passwordCredentials = sqliteTable("password_credentials", {
    userId: text("user_id").primaryKey().references(() => users.id),
    passwordHash: text("password_hash").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: text("locked_until"),
    updatedAt: text("updated_at").notNull(),
});

export const devicePermissions = sqliteTable(
    "device_permissions",
    {
        id: text("id").primaryKey(),
        userId: text("user_id").notNull().references(() => users.id),
        deviceId: text("device_id").notNull(),
        role: text("role", { enum: ["owner", "viewer"] }).notNull(),
        createdAt: text("created_at").notNull(),
    },
    (t) => ({
        userDeviceUnique: unique("uq_dp_user_device").on(t.userId, t.deviceId),
        deviceIdx: index("idx_dp_device").on(t.deviceId),
        userIdx: index("idx_dp_user").on(t.userId),
    })
);

export const deviceInvitations = sqliteTable(
    "device_invitations",
    {
        id: text("id").primaryKey(),
        deviceId: text("device_id").notNull(),
        email: text("email").notNull(),
        role: text("role", { enum: ["owner", "viewer"] }).notNull(),
        issuedBy: text("issued_by").notNull().references(() => users.id),
        createdAt: text("created_at").notNull(),
        expiresAt: text("expires_at").notNull(),
        consumedAt: text("consumed_at"),
    },
    (t) => ({
        deviceIdx: index("idx_di_device").on(t.deviceId),
        emailIdx: index("idx_di_email").on(t.email),
    })
);

export const auditLogs = sqliteTable(
    "audit_logs",
    {
        id: text("id").primaryKey(),
        actorUserId: text("actor_user_id"),
        eventCode: text("event_code").notNull(),
        targetType: text("target_type"),
        targetId: text("target_id"),
        metaJson: text("meta_json"),
        ip: text("ip"),
        createdAt: text("created_at").notNull(),
    },
    (t) => ({
        actorIdx: index("idx_al_actor").on(t.actorUserId),
        eventIdx: index("idx_al_event").on(t.eventCode),
        createdIdx: index("idx_al_created").on(t.createdAt),
    })
);
