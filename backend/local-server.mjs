/**
 * 本地后端：把 Node HTTP 请求适配成 Web 标准 Request，交给同一份 Worker 代码处理。
 * 用法：
 *   node backend/local-server.mjs
 *   PORT=4400 DB_PATH=data/local.db node backend/local-server.mjs
 *
 * 可选：设置 ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD 自动创建管理员。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './app.mjs';
import { createLocalDb } from './local-db.mjs';
import { ensureSchema } from './db.mjs';
import { CATEGORIES } from '../shared/categories.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4400);
const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || 'data/local.db');

const db = createLocalDb(DB_PATH);
await ensureSchema(db, CATEGORIES);

const env = {
  DB: db,
  APP_SECRET: process.env.APP_SECRET || 'local-development-secret-do-not-use-in-prod',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',
  SITE_NAME: process.env.SITE_NAME || '破甲论坛',
  PASSWORD_ITERATIONS: process.env.PASSWORD_ITERATIONS || '60000',
  ENVIRONMENT: 'local',
};

async function seedAdmin() {
  const { ADMIN_USERNAME: u, ADMIN_EMAIL: e, ADMIN_PASSWORD: p } = process.env;
  if (!u || !e || !p) return;
  const { hashPassword } = await import('./auth.mjs');
  const { first, run } = await import('./db.mjs');
  const existing = await first(db, 'SELECT id FROM users WHERE username_lower = ?', u.toLowerCase());
  const now = new Date().toISOString();
  const hash = await hashPassword(p);
  if (existing) {
    await run(db, "UPDATE users SET role = 'admin', password_hash = ?, email = ?, email_lower = ? WHERE id = ?", hash, e, e.toLowerCase(), existing.id);
    console.log(`[local] 已更新管理员 ${u}`);
  } else {
    const info = await run(
      db,
      `INSERT INTO users (username, username_lower, email, email_lower, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, 'admin', ?)`,
      u, u.toLowerCase(), e, e.toLowerCase(), hash, now
    );
    console.log(`[local] 已创建管理员 ${u} (id=${info.lastId})`);
  }
}
await seedAdmin();

function toHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else headers.set(key, String(value));
  }
  return headers;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const url = `http://${host}${req.url}`;
    const method = req.method || 'GET';
    let body;
    if (method !== 'GET' && method !== 'HEAD') body = await readBody(req);
    const request = new Request(url, { method, headers: toHeaders(req.headers), body });
    const response = await handleApi(request, env, {});
    const outHeaders = {};
    response.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, outHeaders);
    res.end(buffer);
  } catch (err) {
    console.error('[local] request failed', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'internal_error', message: '服务器内部错误' }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[local] 破甲论坛 API listening on http://127.0.0.1:${PORT}`);
  console.log(`[local] DB=${DB_PATH}`);
  console.log('[local] 健康检查: GET /api/health');
});

const shutdown = () => {
  console.log('\n[local] shutting down…');
  server.close(() => {
    try {
      db.close();
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
