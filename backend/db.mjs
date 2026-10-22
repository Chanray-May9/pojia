/**
 * 数据库层：Cloudflare D1 兼容抽象。
 * - 线上：env.DB 是 D1Database，直接满足 prepare().bind().all()/first()/run() 接口。
 * - 本地：backend/local-db.mjs 用 node:sqlite 实现同一套接口。
 */

export const SCHEMA_SQL = `
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
`;

/** D1 / 本地 shim 统一调用包装 */
export async function all(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result?.results ?? [];
}

export async function first(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).first();
  return result ?? null;
}

export async function run(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).run();
  return {
    changes: result?.meta?.changes ?? 0,
    lastId: result?.meta?.last_row_id ?? null,
  };
}

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureSchema(db, categories) {
  await db.exec?.(SCHEMA_SQL);
  if (!db.exec) {
    // 极简兜底：逐条执行
    for (const stmt of SCHEMA_SQL.split(';')) {
      const sql = stmt.trim();
      if (sql) await db.prepare(sql).bind().run();
    }
  }
  // 内置匿名用户：未登录也能发帖/回复，作者显示为“匿名用户”
  await run(
    db,
    `INSERT INTO users (username, username_lower, email, email_lower, password_hash, role, bio, created_at)
     VALUES ('匿名用户', 'anonymous-user', 'anonymous@local.invalid', 'anonymous@local.invalid', '!', 'guest', '', ?)
     ON CONFLICT(username_lower) DO NOTHING`,
    nowIso()
  );
  for (let i = 0; i < categories.length; i++) {
    const c = categories[i];
    await run(
      db,
      `INSERT INTO categories (slug, name, latin, description, sort_order) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, latin = excluded.latin,
         description = excluded.description, sort_order = excluded.sort_order`,
      c.slug,
      c.name,
      c.latin,
      c.description,
      i + 1
    );
  }
}
