import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const devices = sqliteTable(
    "devices",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        timezone: text("timezone").notNull().default("Asia/Seoul"),
        agentVersion: text("agent_version"),
        lastSeenAt: text("last_seen_at"),
        isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    (t) => ({
        lastSeenIdx: index("idx_devices_last_seen").on(t.lastSeenAt),
        activeIdx: index("idx_devices_active").on(t.isActive),
    })
);
