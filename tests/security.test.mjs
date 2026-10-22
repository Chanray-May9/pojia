// tests/security.test.mjs — D. 安全验收：PBKDF2 口令、Token 摘要、越权、伪造 Bearer
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  startApi,
  apiFetch,
  seedForum,
  registerApi,
  makeUser,
} from './helpers.mjs';

const PORT = 4411;
const ADMIN = {
  username: 'qa_admin',
  email: 'qa_admin@example.test',
  password: 'AdminPassw0rd!2026',
};
let srv;
let bootError = null;
let seed;
let adminToken = null;

before(async () => {
  try {
    srv = await startApi({
      port: PORT,
      dbFile: 'security-test.db',
      env: {
        ADMIN_USERNAME: ADMIN.username,
        ADMIN_EMAIL: ADMIN.email,
        ADMIN_PASSWORD: ADMIN.password,
      },
    });
    seed = await seedForum(srv.base);
    const login = await apiFetch(srv.base, 'POST', '/api/v1/auth/login', {
      body: { login: ADMIN.username, password: ADMIN.password },
    });
    if (login.status === 200 && login.json?.token) adminToken = login.json.token;
  } catch (e) {
    bootError = e;
  }
});

after(async () => {
  if (srv) await srv.stop();
});

function requireBoot() {
  assert.equal(bootError, null, `后端启动/播种失败: ${bootError && bootError.stack}`);
}

function openTestDb() {
  return new DatabaseSync(srv.dbPath, { readOnly: false });
}

function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function findHashColumn(columns) {
  return columns.find((c) => /(pass|pwd|hash|secret|digest|salt)/i.test(c));
}

test('用户口令以 PBKDF2 哈希存储，数据库中不存在明文口令', async () => {
  requireBoot();
  const u = makeUser('sec');
  await registerApi(srv.base, u);

  const db = openTestDb();
  try {
    const cols = tableInfo(db, 'users');
    assert.ok(cols.length > 0, 'users 表应存在');
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(u.username);
    assert.ok(row, `数据库中应有用户 ${u.username}`);

    const values = Object.entries(row).filter(([, v]) => typeof v === 'string');
    for (const [col, val] of values) {
      assert.ok(!String(val).includes(u.password), `列 ${col} 中出现了明文口令`);
      assert.notEqual(val, u.password, `列 ${col} 直接存储了明文口令`);
    }

    const hashCol = findHashColumn(cols);
    assert.ok(hashCol, `users 表应有口令哈希列，实际列: ${cols.join(',')}`);
    const hash = String(row[hashCol]);
    assert.ok(hash.length >= 40, `口令哈希长度异常: ${hash.slice(0, 40)}...`);
    assert.match(hash, /pbkdf2|PBKDF2/i, `口令哈希应为 PBKDF2 方案，实际值前 60 字符: ${hash.slice(0, 60)}`);
  } finally {
    db.close();
  }
});

test('会话只存 SHA-256 摘要：数据库无原始 token', async () => {
  requireBoot();
  const u = makeUser('sec');
  const reg = await registerApi(srv.base, u);
  const token = reg.json.token;

  const db = openTestDb();
  try {
    const cols = tableInfo(db, 'sessions');
    assert.ok(cols.length > 0, 'sessions 表应存在');
    const rows = db.prepare('SELECT * FROM sessions').all();
    assert.ok(rows.length >= 1, '登录后应有会话记录');

    const hex = createHash('sha256').update(token).digest('hex');
    const b64 = createHash('sha256').update(token).digest('base64');
    const flat = rows.flatMap((r) => Object.values(r).filter((v) => typeof v === 'string'));

    assert.ok(!flat.some((v) => v === token), 'sessions 表不应存储原始 token');
    assert.ok(
      flat.some((v) => v === hex || v === b64 || v.toLowerCase() === hex),
      'sessions 表应存储 token 的 SHA-256 摘要（hex 或 base64）',
    );
  } finally {
    db.close();
  }
});

test('鉴权语义：缺失 Bearer 匿名发布 201；伪造/篡改 Bearer 一律 401', async () => {
  requireBoot();
  const cases = [
    { label: '乱码', token: 'not-a-real-token-abcdef' },
    { label: '篡改', token: seed.token.slice(0, -3) + 'zzz' },
  ];
  for (const c of cases) {
    const me = await apiFetch(srv.base, 'GET', '/auth/me', { token: c.token });
    assert.equal(me.status, 401, `${c.label} token 调 /auth/me 应 401，实际 ${me.status}`);

    const write = await apiFetch(srv.base, 'POST', '/threads', {
      token: c.token,
      body: { category: 'jailbreak', title: `${c.label} token 发帖测试`, body: '正文长度足够用于校验。' },
    });
    assert.equal(write.status, 401, `${c.label} token 写操作应 401，实际 ${write.status}`);
    assert.equal(write.json?.error, 'invalid_token', `${c.label} token 错误码应为 invalid_token，实际 ${write.json?.error}`);
  }

  // 缺失 Authorization：匿名发布（201），作者=匿名用户；不静默降级为失败
  const anonTitle = `安全匿名发帖 ${Date.now().toString(36)}`;
  const anon = await apiFetch(srv.base, 'POST', '/threads', {
    body: { category: 'jailbreak', title: anonTitle, body: '匿名发布正文长度足够。', verification: 'none' },
  });
  assert.equal(anon.status, 201, `缺失 Bearer 应匿名发布 201，实际 ${anon.status}`);
  assert.equal(anon.json?.thread?.author, '匿名用户', '匿名帖作者应为匿名用户');

  const anonReply = await apiFetch(srv.base, 'POST', `/threads/${seed.threads[0].id}/replies`, {
    body: { body: `安全匿名回帖 ${Date.now().toString(36)}` },
  });
  assert.equal(anonReply.status, 201, `缺失 Bearer 回帖应匿名发布 201，实际 ${anonReply.status}`);
  assert.equal(anonReply.json?.post?.author, '匿名用户', '匿名回帖作者应为匿名用户');
});

test('内置匿名用户无法登录（占位密码哈希）', async () => {
  requireBoot();
  for (const login of ['匿名用户', 'anonymous-user']) {
    const res = await apiFetch(srv.base, 'POST', '/auth/login', {
      body: { login, password: '!' },
    });
    assert.ok([400, 401].includes(res.status), `匿名用户不应能登录（login=${login}），实际 ${res.status}`);
  }
});

test('普通用户不能调用管理端复核接口（403）', async () => {
  requireBoot();
  const res = await apiFetch(srv.base, 'POST', `/threads/${seed.threads[0].id}/verify`, {
    token: seed.token,
    body: { verification: 'admin' },
  });
  assert.equal(res.status, 403, `普通用户复核应 403，实际 ${res.status}`);
});

test('管理员复核后 verification=admin 且对公开接口可见', async () => {
  requireBoot();
  assert.ok(adminToken, '管理员账号应通过 ADMIN_USERNAME/ADMIN_PASSWORD 自动创建并可登录');

  const res = await apiFetch(srv.base, 'POST', `/threads/${seed.threads[1].id}/verify`, {
    token: adminToken,
    body: { verification: 'admin' },
  });
  assert.equal(res.status, 200, `管理员复核应 200，实际 ${res.status} ${res.text.slice(0, 300)}`);

  const detail = await apiFetch(srv.base, 'GET', `/threads/${seed.threads[1].id}`);
  const thread = detail.json?.thread || detail.json;
  assert.equal(thread.verification, 'admin', '复核后详情 verification 应为 admin');
  assert.ok(thread.verification_label, '详情应返回 verification_label 中文文案');
});

test('发帖时 verification 非法值被拒（只允许 none/self，admin 需复核接口）', async () => {
  requireBoot();
  const catSlug = seed.threads[0].category || 'jailbreak';
  for (const bad of ['verified', 'true', 'ADMIN ']) {
    const res = await apiFetch(srv.base, 'POST', '/threads', {
      token: seed.token,
      body: {
        category: catSlug,
        title: `非法验证值 ${bad} 测试`,
        body: '正文长度足够用于校验。',
        verification: bad,
      },
    });
    assert.ok([400, 403].includes(res.status), `verification=${JSON.stringify(bad)} 应 400/403，实际 ${res.status}`);
  }
});

test('XSS 内容在 API 层作为 JSON 纯数据返回（HTML 转义由 SSG 层负责）', async () => {
  requireBoot();
  const catSlug = seed.threads[0].category || 'jailbreak';
  const payload = '<script>alert(1)</script> <img src=x onerror=alert(2)>';
  const res = await apiFetch(srv.base, 'POST', '/threads', {
    token: seed.token,
    body: { category: catSlug, title: 'XSS 存储验收', body: payload },
  });
  assert.equal(res.status, 201);
  const detail = await apiFetch(srv.base, 'GET', `/threads/${res.json.thread.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.contentType, /application\/json/i, 'API 必须返回 application/json');
  const body = detail.json?.thread?.body || '';
  assert.ok(body.includes(payload), 'API 应原样保存正文（转义责任在渲染层）');
  assert.ok(!/<img[^>]+onerror=/i.test(detail.headers.get('content-type') || ''), 'Content-Type 不应被污染');
});
