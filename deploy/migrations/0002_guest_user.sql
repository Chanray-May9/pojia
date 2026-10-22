-- 内置匿名用户：未登录也可以发帖/回帖，作者显示为“匿名用户”。
-- 密码哈希为占位符 '!'，该账号永远无法登录。
INSERT INTO users (username, username_lower, email, email_lower, password_hash, role, bio, created_at)
VALUES ('匿名用户', 'anonymous-user', 'anonymous@local.invalid', 'anonymous@local.invalid', '!', 'guest', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(username_lower) DO NOTHING;
