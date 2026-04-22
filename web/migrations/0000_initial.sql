-- TickTock initial schema (auth + devices)

CREATE TABLE `users` (
    `id` text PRIMARY KEY NOT NULL,
    `email` text NOT NULL,
    `display_name` text NOT NULL,
    `phone` text,
    `firebase_uid` text,
    `is_active` integer DEFAULT 1 NOT NULL,
    `created_at` text NOT NULL,
    `updated_at` text NOT NULL
);
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
CREATE UNIQUE INDEX `users_firebase_uid_unique` ON `users` (`firebase_uid`);
CREATE INDEX `idx_users_email` ON `users` (`email`);
CREATE INDEX `idx_users_firebase_uid` ON `users` (`firebase_uid`);

CREATE TABLE `password_credentials` (
    `user_id` text PRIMARY KEY NOT NULL,
    `password_hash` text NOT NULL,
    `failed_attempts` integer DEFAULT 0 NOT NULL,
    `locked_until` text,
    `updated_at` text NOT NULL,
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `device_permissions` (
    `id` text PRIMARY KEY NOT NULL,
    `user_id` text NOT NULL,
    `device_id` text NOT NULL,
    `role` text NOT NULL,
    `created_at` text NOT NULL,
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX `uq_dp_user_device` ON `device_permissions` (`user_id`, `device_id`);
CREATE INDEX `idx_dp_device` ON `device_permissions` (`device_id`);
CREATE INDEX `idx_dp_user` ON `device_permissions` (`user_id`);

CREATE TABLE `device_invitations` (
    `id` text PRIMARY KEY NOT NULL,
    `device_id` text NOT NULL,
    `email` text NOT NULL,
    `role` text NOT NULL,
    `issued_by` text NOT NULL,
    `created_at` text NOT NULL,
    `expires_at` text NOT NULL,
    `consumed_at` text,
    FOREIGN KEY (`issued_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE INDEX `idx_di_device` ON `device_invitations` (`device_id`);
CREATE INDEX `idx_di_email` ON `device_invitations` (`email`);

CREATE TABLE `audit_logs` (
    `id` text PRIMARY KEY NOT NULL,
    `actor_user_id` text,
    `event_code` text NOT NULL,
    `target_type` text,
    `target_id` text,
    `meta_json` text,
    `ip` text,
    `created_at` text NOT NULL
);
CREATE INDEX `idx_al_actor` ON `audit_logs` (`actor_user_id`);
CREATE INDEX `idx_al_event` ON `audit_logs` (`event_code`);
CREATE INDEX `idx_al_created` ON `audit_logs` (`created_at`);

CREATE TABLE `devices` (
    `id` text PRIMARY KEY NOT NULL,
    `name` text NOT NULL,
    `timezone` text DEFAULT 'Asia/Seoul' NOT NULL,
    `agent_version` text,
    `last_seen_at` text,
    `is_active` integer DEFAULT 1 NOT NULL,
    `created_at` text NOT NULL,
    `updated_at` text NOT NULL
);
CREATE INDEX `idx_devices_last_seen` ON `devices` (`last_seen_at`);
CREATE INDEX `idx_devices_active` ON `devices` (`is_active`);
