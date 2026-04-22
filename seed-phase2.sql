-- TickTock Phase 2 시드 데이터
-- 적용: cd web && npx wrangler d1 execute ticktock-db --local --file=../seed-phase2.sql
-- 계정: jxamen@gmail.com / test1234 (Windows user: jxame)

-- 기존 테스트 데이터 정리 (seed 재실행 대비)
DELETE FROM commands_issued;
DELETE FROM subscription_ledger;
DELETE FROM managed_users;
DELETE FROM device_permissions;
DELETE FROM devices;
DELETE FROM audit_logs;
DELETE FROM password_credentials;
DELETE FROM users;

-- 1. 태훈님 계정
INSERT INTO users (id, email, display_name, phone, firebase_uid, seat_limit, is_active, created_at, updated_at)
VALUES (
    '01KPTR474H11YZXSP13E11YZXS',
    'jxamen@gmail.com',
    '태훈',
    NULL,
    NULL,
    5,
    1,
    '2026-04-22T14:00:00.000Z',
    '2026-04-22T14:00:00.000Z'
);

INSERT INTO password_credentials (user_id, password_hash, failed_attempts, locked_until, updated_at)
VALUES (
    '01KPTR474H11YZXSP13E11YZXS',
    '3f0b7afd04a3a7581396a77e5ee3e7aa:99e6002b261b0b6427433d11b3b345f5164f71c18e9bfad0615c23235a348c01',
    0,
    NULL,
    '2026-04-22T14:00:00.000Z'
);

-- 2. 샘플 디바이스 (태훈님 PC)
INSERT INTO devices (id, name, timezone, agent_version, last_seen_at, is_active, created_at, updated_at)
VALUES (
    '01KPTR474HZ1RYY0S2QNZ1RYY0',
    '태훈님 PC',
    'Asia/Seoul',
    '0.1.8',
    '2026-04-22T14:00:00.000Z',
    1,
    '2026-04-22T14:00:00.000Z',
    '2026-04-22T14:00:00.000Z'
);

-- 3. owner 권한 연결
INSERT INTO device_permissions (id, user_id, device_id, role, created_at)
VALUES (
    '01KPTR474HVPCK0G2CZVVPCK0G',
    '01KPTR474H11YZXSP13E11YZXS',
    '01KPTR474HZ1RYY0S2QNZ1RYY0',
    'owner',
    '2026-04-22T14:00:00.000Z'
);

-- 4. 자녀 Windows 계정 (본인 테스트용, 무제한 구독)
INSERT INTO managed_users (id, device_id, windows_username, display_name, subscription_status, subscription_expires_at, is_active, created_at, updated_at)
VALUES (
    '01KPTR474H8T8Z760RCQ8T8Z76',
    '01KPTR474HZ1RYY0S2QNZ1RYY0',
    'jxame',
    '태훈 (테스트)',
    'active',
    '2099-12-31T23:59:59.999Z',
    1,
    '2026-04-22T14:00:00.000Z',
    '2026-04-22T14:00:00.000Z'
);

-- 5. 무제한 부여 원장
INSERT INTO subscription_ledger (id, managed_user_id, action, months, effective_from, effective_until, amount_krw, payment_ref, actor_user_id, note, created_at)
VALUES (
    '01KPTR474HQSRYWXAA6AQSRYWX',
    '01KPTR474H8T8Z760RCQ8T8Z76',
    'admin_grant',
    NULL,
    '2026-04-22T14:00:00.000Z',
    '2099-12-31T23:59:59.999Z',
    0,
    NULL,
    '01KPTR474H11YZXSP13E11YZXS',
    '시드 데이터 — 개발자 무제한',
    '2026-04-22T14:00:00.000Z'
);

-- 6. 감사 로그 (시드 생성 기록)
INSERT INTO audit_logs (id, actor_user_id, event_code, target_type, target_id, meta_json, ip, created_at)
VALUES
    ('01KPTR474HC875C9Y115C875C9', '01KPTR474H11YZXSP13E11YZXS', 'user.signup', 'user', '01KPTR474H11YZXSP13E11YZXS', NULL, NULL, '2026-04-22T14:00:00.000Z'),
    ('01KPTR474H4W0EH7QXVZ4W0EH7', '01KPTR474H11YZXSP13E11YZXS', 'managed_user.create', 'managed_user', '01KPTR474H8T8Z760RCQ8T8Z76', '{"deviceId":"01KPTR474HZ1RYY0S2QNZ1RYY0","windowsUsername":"jxame"}', NULL, '2026-04-22T14:00:00.000Z'),
    ('01KPTR474HKYNE9G7DKPKYNE9G', '01KPTR474H11YZXSP13E11YZXS', 'subscription.admin_grant', 'managed_user', '01KPTR474H8T8Z760RCQ8T8Z76', '{"effectiveUntil":"2099-12-31T23:59:59.999Z"}', NULL, '2026-04-22T14:00:00.000Z');
