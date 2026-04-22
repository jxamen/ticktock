-- users 에 seat 한도 추가 (부모 계정당 관리 가능한 자녀 계정 수 상한)
ALTER TABLE `users` ADD COLUMN `seat_limit` integer DEFAULT 5 NOT NULL;

-- 원격 명령 원장 (append-only)
CREATE TABLE `commands_issued` (
    `id` text PRIMARY KEY NOT NULL,
    `managed_user_id` text NOT NULL,
    `device_id` text NOT NULL,
    `type` text NOT NULL,
    `payload_json` text,
    `status` text DEFAULT 'pending' NOT NULL,
    `failure_reason` text,
    `issued_by` text NOT NULL,
    `issued_at` text NOT NULL,
    `delivered_at` text,
    `consumed_at` text,
    `created_at` text NOT NULL,
    FOREIGN KEY (`managed_user_id`) REFERENCES `managed_users`(`id`) ON UPDATE no action ON DELETE no action,
    FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
    FOREIGN KEY (`issued_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
    CHECK (`type` IN ('lock','unlock','set_pin','grant_bonus')),
    CHECK (`status` IN ('pending','delivered','consumed','failed','canceled'))
);
CREATE INDEX `idx_ci_managed_user` ON `commands_issued` (`managed_user_id`);
CREATE INDEX `idx_ci_device` ON `commands_issued` (`device_id`);
CREATE INDEX `idx_ci_status` ON `commands_issued` (`status`);
CREATE INDEX `idx_ci_issued_at` ON `commands_issued` (`issued_at`);
