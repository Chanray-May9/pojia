#!/usr/bin/env node
/**
 * 创建/重置站务管理员账号。
 * 用法：
 *   ADMIN_USERNAME=admin ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='...' node scripts/make-admin.mjs
 * 或者交互式：
 *   node scripts/make-admin.mjs --username admin --email admin@example.com --password '...'
 */
import { getDb, closeDb } from '../src/db.mjs';
import { hashPassword, USERNAME_RE, EMAIL_RE } from '../src/auth.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const username = flag('username') || process.env.ADMIN_USERNAME || '';
const email = flag('email') || process.env.ADMIN_EMAIL || '';
const password = flag('password') || process.env.ADMIN_PASSWORD || '';

if (!USERNAME_RE.test(username || '')) {
  console.error('缺少或非法的 --username（3-20 个中文/字母/数字/下划线/短横线）');
  process.exit(1);
}
if (!EMAIL_RE.test(email || '')) {
  console.error('缺少或非法的 --email');
  process.exit(1);
}
if (!password || password.length < 8) {
  console.error('缺少或过短的 --password（至少 8 位）');
  process.exit(1);
}

const conn = getDb();
const now = new Date().toISOString();
const existing = conn.prepare('SELECT id FROM users WHERE username_lower = ?').get(username.toLowerCase());
if (existing) {
  conn
    .prepare("UPDATE users SET role = 'admin', password_hash = ?, email = ?, email_lower = ? WHERE id = ?")
    .run(hashPassword(password), email, email.toLowerCase(), existing.id);
  console.log(`已更新管理员：${username}（id=${existing.id}）`);
} else {
  const info = conn
    .prepare(
      `INSERT INTO users (username, username_lower, email, email_lower, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, 'admin', ?)`
    )
    .run(username, username.toLowerCase(), email, email.toLowerCase(), hashPassword(password), now);
  console.log(`已创建管理员：${username}（id=${info.lastInsertRowid}）`);
}
closeDb();
