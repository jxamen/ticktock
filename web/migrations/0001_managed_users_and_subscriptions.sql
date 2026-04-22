-- 자녀 Windows 계정 단위의 구독 모델
-- device = PC 한 대, managed_user = 해당 PC 의 자녀 Windows 계정 (구독 단위)

CREATE TABLE `managed_users` (
    `id` text PRIMARY KEY NOT NULL,
    `device_id` text NOT NULL,
    `windows_username` text NOT NULL,
    `display_name` text NOT NULL,
    `subscription_status` text DEFAULT 'expired' NOT NULL,
    `subscription_expires_at` text,
    `is_active` integer DEFAULT 1 NOT NULL,
    `created_at` text NOT NULL,
    `updated_at` text NOT NULL,
    FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
    CHECK (`subscription_status` IN ('active','expired'))
);
CREATE UNIQUE INDEX `uq_mu_device_username` ON `managed_users` (`device_id`, `windows_username`);
CREATE INDEX `idx_mu_device` ON `managed_users` (`device_id`);
CREATE INDEX `idx_mu_expires` ON `managed_users` (`subscription_expires_at`);
CREATE INDEX `idx_mu_active` ON `managed_users` (`is_active`);

CREATE TABLE `subscription_ledger` (
    `id` text PRIMARY KEY NOT NULL,
    `managed_user_id` text NOT NULL,
    `action` text NOT NULL,
    `months` integer,
    `effective_from` text NOT NULL,
    `effective_until` text NOT NULL,
    `amount_krw` integer DEFAULT 0 NOT NULL,
    `payment_ref` text,
    `actor_user_id` text NOT NULL,
    `note` text,
    `created_at` text NOT NULL,
    FOREIGN KEY (`managed_user_id`) REFERENCES `managed_users`(`id`) ON UPDATE no action ON DELETE no action,
    FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
    CHECK (`action` IN ('extend','admin_grant','revoke'))
);
CREATE INDEX `idx_sl_managed_user` ON `subscription_ledger` (`managed_user_id`);
CREATE INDEX `idx_sl_created` ON `subscription_ledger` (`created_at`);
CREATE INDEX `idx_sl_actor` ON `subscription_ledger` (`actor_user_id`);
