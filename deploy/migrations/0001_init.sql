-- 破甲论坛 D1 初始迁移（0001_init）
-- schema 部分与 backend/schema.sql 完全一致（逐条对应，勿单独修改其中一侧）。
-- 追加内容：7 个板块的种子数据（文案来自 shared/categories.mjs）。
--
-- 应用方式：
--   npx wrangler d1 migrations apply pojia --remote --config deploy/wrangler.toml
-- 本地验证（不连线上）：
--   npx wrangler d1 migrations apply pojia --local --config deploy/wrangler.toml

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  username_lower TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  email_lower TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  bio TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS categories (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latin TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  body TEXT NOT NULL,
  models TEXT NOT NULL DEFAULT '',
  model_custom TEXT NOT NULL DEFAULT '',
  verification TEXT NOT NULL DEFAULT 'none',
  verified_at TEXT,
  verified_by INTEGER,
  views INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_post_at TEXT NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_threads_cat ON threads(category, last_post_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_last ON threads(last_post_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_author ON threads(author_id);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  floor INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, id);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reporter_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_key ON login_attempts(key, created_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 7 个初始板块种子数据（幂等：重复执行只更新文案，不产生重复行）。
-- slug / name / latin / description 与 shared/categories.mjs 保持一致；
-- 站点上线后任何登录用户还可以通过 /category/new/（POST /api/v1/categories）自建更多板块。
INSERT INTO categories (slug, name, latin, description, sort_order) VALUES
  ('jailbreak', '越狱实战', 'JAILBREAK', '角色扮演、多轮诱导、编码绕过、上下文挤压——只发真打实测、能复现的越狱路径。', 1),
  ('injection', '提示词注入', 'INJECTION', '直接注入、间接注入、工具投毒与 Agent 上下文劫持的攻击链路复盘。', 2),
  ('redteam', '红队评估', 'RED TEAM', '评估方案、用例库、评分口径与报告模板：把"能绕"变成可交付的结论。', 3),
  ('defense', '防御与对齐', 'DEFENSE', '拒绝策略、系统提示加固、输出过滤与评测回归——看清对方的甲补在哪。', 4),
  ('tooling', '工具与资源', 'TOOLING', '攻击框架、自动化 harness、数据集、论文与现成利用链。', 5),
  ('vuln', '模型漏洞', 'VULN', '模型与 Agent 的漏洞发现、复现条件、影响面与披露节奏。', 6),
  ('general', '综合讨论', 'GENERAL', '行业观察、边界讨论、社区事务与新人提问。', 7)
ON CONFLICT(slug) DO UPDATE SET
  name = excluded.name,
  latin = excluded.latin,
  description = excluded.description,
  sort_order = excluded.sort_order;
