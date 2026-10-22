/**
 * 本地开发用的 D1 兼容层：用 node:sqlite 模拟 D1Database 的最小接口。
 * 线上不需要这个文件（Worker 直接使用 env.DB）。
 */
import { DatabaseSync } from 'node:sqlite';

function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function createLocalDb(filePath) {
  const raw = new DatabaseSync(filePath);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');

  return {
    __raw: raw,
    prepare(sql) {
      return {
        bind(...params) {
          const args = params.map(normalizeParam);
          return {
            async all() {
              const results = raw.prepare(sql).all(...args);
              return { results, success: true, meta: {} };
            },
            async first() {
              return raw.prepare(sql).get(...args) ?? null;
            },
            async run() {
              const info = raw.prepare(sql).run(...args);
              return {
                success: true,
                meta: {
                  changes: Number(info.changes ?? 0),
                  last_row_id: Number(info.lastInsertRowid ?? 0),
                },
              };
            },
          };
        },
      };
    },
    async exec(sql) {
      raw.exec(sql);
      return { count: 1, duration: 0 };
    },
    async batch(statements) {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run());
      return out;
    },
    close() {
      raw.close();
    },
  };
}

export function createLocalEnv({ dbPath, siteName, allowedOrigins } = {}) {
  const db = createLocalDb(dbPath || ':memory:');
  return {
    DB: db,
    APP_SECRET: process.env.APP_SECRET || 'local-development-secret-do-not-use-in-prod',
    ALLOWED_ORIGINS: allowedOrigins || process.env.ALLOWED_ORIGINS || '*',
    SITE_NAME: siteName || '破甲论坛',
    PASSWORD_ITERATIONS: process.env.PASSWORD_ITERATIONS || '60000',
    ENVIRONMENT: 'local',
    __close: () => db.close(),
  };
}
