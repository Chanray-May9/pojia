/**
 * 破甲论坛 API（Cloudflare Worker 入口逻辑）
 * 纯 Web 标准 Request/Response；本地由 backend/local-server.mjs 适配运行。
 */
import { CATEGORIES, CATEGORY_MAP, VERIFICATION_LABELS } from '../shared/categories.mjs';
import { MODELS, MODEL_MAP, MAX_MODELS_PER_THREAD, parseModels, modelLabels } from '../shared/models.mjs';
import { BRAND } from '../shared/brand.mjs';
import {
  bearerToken,
  hashPassword,
  verifyPassword,
  randomToken,
  sha256Hex,
  newSessionExpiry,
  iterationsFromEnv,
  USERNAME_RE,
  EMAIL_RE,
} from './auth.mjs';
import { all, first, run, nowIso } from './db.mjs';

const API_VERSION = '1.0.0';
const JSON_LIMIT_BYTES = 256 * 1024;
const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/* ------------------------------------------------------------------ utils */

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const raw = String(env.ALLOWED_ORIGINS || '').trim();
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const hits =
    allowed.includes('*') ||
    allowed.includes(origin) ||
    (env.ENVIRONMENT === 'local' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin));
  if (!hits) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function withHeaders(body, status = 200, headers = {}) {
  return new Response(body == null ? null : body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function json(data, status = 200, extra = {}) {
  return withHeaders(JSON.stringify(data), status, extra);
}

function apiError(status, code, message, fields = null, extra = {}) {
  const payload = { error: code, message };
  if (fields) payload.fields = fields;
  return json(payload, status, extra);
}

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

async function ipHash(request, env) {
  const ip = clientIp(request);
  return sha256Hex(`${env.APP_SECRET || 'x'}:${ip}`).then((h) => h.slice(0, 32));
}

function str(value, max = 10000) {
  if (value == null) return '';
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function intParam(url, name, fallback, min, max) {
  const n = Number.parseInt(url.searchParams.get(name) ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  const text = await request.text();
  if (text.length > JSON_LIMIT_BYTES) {
    return { error: apiError(413, 'payload_too_large', '请求体过大') };
  }
  if (!text) return { data: {} };
  if (/application\/x-www-form-urlencoded/i.test(type)) {
    const params = new URLSearchParams(text);
    const out = {};
    for (const [k, v] of params) {
      if (k.endsWith('[]')) {
        const key = k.slice(0, -2);
        out[key] = [...(Array.isArray(out[key]) ? out[key] : out[key] ? [out[key]] : []), v];
      } else if (k in out) {
        out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
      } else {
        out[k] = v;
      }
    }
    return { data: out };
  }
  try {
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { error: apiError(400, 'invalid_body', '请求体必须是 JSON 对象') };
    }
    return { data };
  } catch {
    return { error: apiError(400, 'invalid_json', '请求体不是合法 JSON') };
  }
}

function slugify(title) {
  const base = String(title || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || 'thread';
}

function threadPath(row) {
  return `/t/${row.id}-${row.slug}/`;
}

/* ------------------------------------------------------------------- auth */

async function resolveAuth(request, env) {
  const db = env.DB;
  const token = bearerToken(request);
  if (!token) return { user: null, tokenHash: null };
  const tokenHash = await sha256Hex(token);
  const row = await first(
    db,
    `SELECT s.expires_at, s.user_id, u.username, u.email, u.role, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    tokenHash
  );
  if (!row) return { user: null, tokenHash: null };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await run(db, 'DELETE FROM sessions WHERE token_hash = ?', tokenHash);
    return { user: null, tokenHash: null };
  }
  return {
    user: { id: Number(row.user_id), username: row.username, email: row.email, role: row.role, created_at: row.created_at },
    tokenHash,
  };
}

async function createSession(db, userId) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = nowIso();
  await run(
    db,
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    tokenHash,
    userId,
    now,
    newSessionExpiry()
  );
  return { token, tokenHash };
}

async function tooManyAttempts(db, key, limit, windowMs) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = await first(
    db,
    'SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND created_at >= ?',
    key,
    since
  );
  return Number(row?.n || 0) >= limit;
}

async function recordAttempt(db, key) {
  await run(db, 'INSERT INTO login_attempts (key, created_at) VALUES (?, ?)', key, nowIso());
}

function publicUser(user, extra = {}) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    created_at: user.created_at,
    ...extra,
  };
}

async function userStats(db, userId) {
  const row = await first(
    db,
    `SELECT (SELECT COUNT(*) FROM threads WHERE author_id = ?) AS threads,
            (SELECT COUNT(*) FROM posts WHERE author_id = ?) AS posts`,
    userId,
    userId
  );
  return { threads: Number(row?.threads || 0), posts: Number(row?.posts || 0) };
}

/**
 * 发帖/回复的“操作者”：登录用户优先；未登录时回退到内置匿名用户。
 * 匿名不需要注册，但按 IP 限流。
 */
async function resolveActor(ctx, { allowGuest = false } = {}) {
  if (ctx.auth.user) return { userId: ctx.auth.user.id, username: ctx.auth.user.username, isGuest: false };
  if (!allowGuest) return null;
  const guest = await first(ctx.env.DB, "SELECT id, username FROM users WHERE role = 'guest' ORDER BY id LIMIT 1");
  if (!guest) return null;
  return { userId: Number(guest.id), username: guest.username, isGuest: true };
}

async function categoryExists(db, slug) {
  if (!slug) return false;
  const row = await first(db, 'SELECT slug FROM categories WHERE slug = ?', slug);
  return Boolean(row);
}

/* --------------------------------------------------------------- serializers */

function serializeCategory(row) {
  return {
    slug: row.slug,
    name: row.name,
    latin: row.latin || '',
    description: row.description || '',
    sort_order: Number(row.sort_order || 0),
    thread_count: Number(row.thread_count || 0),
    post_count: Number(row.post_count || 0),
    last_post_at: row.last_post_at || null,
  };
}

function serializeThread(row, { includeBody = true } = {}) {
  const ids = row.models ? String(row.models).split(',').filter(Boolean) : [];
  return {
    id: Number(row.id),
    title: row.title,
    slug: row.slug,
    path: threadPath(row),
    category: row.category,
    category_name: row.category_name || CATEGORY_MAP.get(row.category)?.name || row.category,
    author: row.author,
    author_role: row.author_role || 'member',
    body: includeBody ? row.body : undefined,
    excerpt: includeBody ? undefined : String(row.body || '').replace(/\s+/g, ' ').slice(0, 180),
    models: ids,
    model_labels: modelLabels(ids),
    model_custom: row.model_custom || '',
    verification: row.verification || 'none',
    verification_label: VERIFICATION_LABELS[row.verification] || VERIFICATION_LABELS.none,
    verified_at: row.verified_at || null,
    views: Number(row.views || 0),
    locked: Boolean(row.locked),
    pinned: Boolean(row.pinned),
    reply_count: Number(row.reply_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_post_at: row.last_post_at,
  };
}

function serializePost(row) {
  return {
    id: Number(row.id),
    thread_id: Number(row.thread_id),
    floor: Number(row.floor),
    body: row.body,
    author: row.author,
    author_role: row.author_role || 'member',
    created_at: row.created_at,
  };
}

const THREAD_SELECT = `
  SELECT t.*, u.username AS author, u.role AS author_role,
         c.name AS category_name, c.latin AS category_latin
  FROM threads t
  JOIN users u ON u.id = t.author_id
  JOIN categories c ON c.slug = t.category`;

/* ----------------------------------------------------------------- routes */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            keys.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$'
  );
  routes.push({ method, regex, keys, handler });
}

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return { handler: r.handler, params, pathMatched: true };
  }
  return { handler: null, params: {}, pathMatched };
}

/* health ------------------------------------------------------------------ */
route('GET', '/api/health', async (ctx) => {
  const row = await first(ctx.env.DB, 'SELECT COUNT(*) AS n FROM categories');
  return json({
    ok: true,
    version: API_VERSION,
    time: nowIso(),
    categories: Number(row?.n || 0),
    environment: ctx.env.ENVIRONMENT || 'cloudflare',
  });
});

/* site snapshot (SSG) ----------------------------------------------------- */
route('GET', '/api/v1/site', async (ctx) => {
  const { db, url } = ctx;
  const page = intParam(url, 'page', 1, 1, 1000);
  const pageSize = intParam(url, 'page_size', 200, 1, 200);

  const statsRow = await first(
    db,
    `SELECT (SELECT COUNT(*) FROM threads) AS threads,
            (SELECT COUNT(*) FROM posts) AS posts,
            (SELECT COUNT(*) FROM users) AS users,
            (SELECT MAX(last_post_at) FROM threads) AS last_activity`
  );
  const catRows = await all(
    db,
    `SELECT c.slug, c.name, c.latin, c.description, c.sort_order,
            COUNT(t.id) AS thread_count,
            COALESCE(MAX(t.last_post_at), '') AS last_post_at,
            (SELECT COUNT(*) FROM posts p JOIN threads t2 ON t2.id = p.thread_id WHERE t2.category = c.slug) AS post_count
     FROM categories c LEFT JOIN threads t ON t.category = c.slug
     GROUP BY c.slug ORDER BY c.sort_order ASC`
  );
  const total = Number((await first(db, 'SELECT COUNT(*) AS n FROM threads'))?.n || 0);
  const threadRows = await all(
    db,
    `${THREAD_SELECT} ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT ? OFFSET ?`,
    pageSize,
    (page - 1) * pageSize
  );
  let posts = [];
  if (threadRows.length) {
    const ids = threadRows.map((t) => Number(t.id));
    const placeholders = ids.map(() => '?').join(',');
    posts = await all(
      db,
      `SELECT p.id, p.thread_id, p.floor, p.body, p.created_at, u.username AS author, u.role AS author_role
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.thread_id IN (${placeholders}) ORDER BY p.id ASC`,
      ...ids
    );
  }
  const postsByThread = new Map();
  for (const p of posts) {
    const key = Number(p.thread_id);
    if (!postsByThread.has(key)) postsByThread.set(key, []);
    postsByThread.get(key).push(serializePost(p));
  }
  const userRows = await all(
    db,
    `SELECT u.id, u.username, u.role, u.created_at,
            (SELECT COUNT(*) FROM threads WHERE author_id = u.id) AS thread_count,
            (SELECT COUNT(*) FROM posts WHERE author_id = u.id) AS post_count
     FROM users u ORDER BY u.id ASC LIMIT 500`
  );

  return json({
    generated_at: nowIso(),
    stats: {
      threads: Number(statsRow?.threads || 0),
      posts: Number(statsRow?.posts || 0),
      users: Number(statsRow?.users || 0),
      last_activity: statsRow?.last_activity || null,
    },
    categories: catRows.map(serializeCategory),
    threads: threadRows.map((t) => ({
      ...serializeThread(t),
      posts: postsByThread.get(Number(t.id)) || [],
    })),
    users: userRows.map((u) => ({
      id: Number(u.id),
      username: u.username,
      role: u.role,
      created_at: u.created_at,
      thread_count: Number(u.thread_count || 0),
      post_count: Number(u.post_count || 0),
    })),
    pagination: { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) },
  });
});

/* categories -------------------------------------------------------------- */
route('GET', '/api/v1/categories', async (ctx) => {
  const rows = await all(
    ctx.env.DB,
    `SELECT c.slug, c.name, c.latin, c.description, c.sort_order,
            COUNT(t.id) AS thread_count,
            COALESCE(MAX(t.last_post_at), '') AS last_post_at,
            (SELECT COUNT(*) FROM posts p JOIN threads t2 ON t2.id = p.thread_id WHERE t2.category = c.slug) AS post_count
     FROM categories c LEFT JOIN threads t ON t.category = c.slug
     GROUP BY c.slug ORDER BY c.sort_order ASC`
  );
  return json({ categories: rows.map(serializeCategory) });
});

/* 自建板块 ---------------------------------------------------------------- */
route('POST', '/api/v1/categories', async (ctx) => {
  const { db, request } = ctx;
  if (!ctx.auth.user) return apiError(401, 'unauthorized', '请先登录');
  if (await tooManyAttempts(db, `category:${ctx.auth.user.id}`, 5, 60 * 60 * 1000)) {
    return apiError(429, 'rate_limited', '新建板块过于频繁，请稍后再试');
  }
  const { data, error } = await readJson(request);
  if (error) return error;
  const name = str(data.name, 40).trim();
  const description = str(data.description, 10000).trim();
  const fields = {};
  if (name.length < 2 || name.length > 20) fields.name = '板块名需 2-20 个字符';
  if (description.length > 120) fields.description = '简介最多 120 个字符';
  if (Object.keys(fields).length) return apiError(400, 'validation_failed', '创建失败：请检查输入', fields);
  await recordAttempt(db, `category:${ctx.auth.user.id}`);

  const total = Number((await first(db, 'SELECT COUNT(*) AS n FROM categories'))?.n || 0);
  if (total >= 60) return apiError(400, 'too_many_categories', '板块数量已达上限（60）');

  const existing = await first(db, 'SELECT slug FROM categories WHERE name = ?', name);
  if (existing) return apiError(409, 'duplicate', '同名板块已存在');

  const ascii = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  let slug = ascii || `sector-${Date.now().toString(36).slice(-6)}`;
  for (let i = 2; i < 100; i++) {
    const dup = await first(db, 'SELECT slug FROM categories WHERE slug = ?', slug);
    if (!dup) break;
    slug = `${ascii || 'sector'}-${i}`;
  }
  const maxOrder = Number((await first(db, 'SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories'))?.m || 0);
  const latin = (ascii ? ascii.replace(/-/g, ' ').toUpperCase() : 'SECTOR').slice(0, 24);
  await run(
    db,
    'INSERT INTO categories (slug, name, latin, description, sort_order) VALUES (?, ?, ?, ?, ?)',
    slug,
    name,
    latin,
    description,
    maxOrder + 1
  );
  const row = await first(
    db,
    `SELECT c.slug, c.name, c.latin, c.description, c.sort_order,
            0 AS thread_count, 0 AS post_count, '' AS last_post_at
     FROM categories c WHERE c.slug = ?`,
    slug
  );
  return json({ category: serializeCategory(row), redirect: `/c/${slug}/` }, 201);
});


/* threads list ------------------------------------------------------------ */
route('GET', '/api/v1/threads', async (ctx) => {
  const { db, url } = ctx;
  const page = intParam(url, 'page', 1, 1, 1000);
  const pageSize = intParam(url, 'page_size', 20, 1, 50);
  const category = url.searchParams.get('category') || '';
  const model = url.searchParams.get('model') || '';
  const verification = url.searchParams.get('verification') || '';
  const where = [];
  const params = [];
  if (category) {
    if (!(await categoryExists(db, category))) return apiError(400, 'invalid_category', '未知板块');
    where.push('t.category = ?');
    params.push(category);
  }
  if (model) {
    where.push("instr(',' || t.models || ',', ?) > 0");
    params.push(`,${model},`);
  }
  if (verification && ['none', 'self', 'admin'].includes(verification)) {
    where.push('t.verification = ?');
    params.push(verification);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    (await first(db, `SELECT COUNT(*) AS n FROM threads t ${whereSql}`, ...params))?.n || 0
  );
  const rows = await all(
    db,
    `${THREAD_SELECT} ${whereSql} ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    (page - 1) * pageSize
  );
  return json({
    threads: rows.map((r) => serializeThread(r, { includeBody: false })),
    pagination: { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) },
  });
});

/* thread detail ----------------------------------------------------------- */
route('GET', '/api/v1/threads/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) return apiError(400, 'invalid_id', '主题 id 非法');
  const row = await first(ctx.env.DB, `${THREAD_SELECT} WHERE t.id = ?`, id);
  if (!row) return apiError(404, 'not_found', '主题不存在');
  const posts = await all(
    ctx.env.DB,
    `SELECT p.id, p.thread_id, p.floor, p.body, p.created_at, u.username AS author, u.role AS author_role
     FROM posts p JOIN users u ON u.id = p.author_id WHERE p.thread_id = ? ORDER BY p.id ASC`,
    id
  );
  return json({ thread: { ...serializeThread(row), posts: posts.map(serializePost) } });
});

/* view counter ------------------------------------------------------------ */
route('POST', '/api/v1/threads/:id/view', async (ctx) => {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) return apiError(400, 'invalid_id', '主题 id 非法');
  const info = await run(ctx.env.DB, 'UPDATE threads SET views = views + 1 WHERE id = ?', id);
  if (!info.changes) return apiError(404, 'not_found', '主题不存在');
  const row = await first(ctx.env.DB, 'SELECT views FROM threads WHERE id = ?', id);
  return json({ ok: true, views: Number(row?.views || 0) });
});

/* search ------------------------------------------------------------------ */
route('GET', '/api/v1/search', async (ctx) => {
  const { db, url } = ctx;
  const q = str(url.searchParams.get('q'), 80).trim();
  const page = intParam(url, 'page', 1, 1, 1000);
  const pageSize = intParam(url, 'page_size', 12, 1, 50);
  if (!q) return json({ q: '', results: [], pagination: { page, page_size: pageSize, total: 0, total_pages: 1 } });
  const like = `%${q}%`;
  const total = Number(
    (
      await first(
        db,
        `SELECT COUNT(*) AS n FROM threads t WHERE t.title LIKE ? OR t.body LIKE ?
         OR EXISTS (SELECT 1 FROM posts p WHERE p.thread_id = t.id AND p.body LIKE ?)`,
        like,
        like,
        like
      )
    )?.n || 0
  );
  const rows = await all(
    db,
    `${THREAD_SELECT}
     WHERE t.title LIKE ? OR t.body LIKE ?
        OR EXISTS (SELECT 1 FROM posts p WHERE p.thread_id = t.id AND p.body LIKE ?)
     ORDER BY t.last_post_at DESC LIMIT ? OFFSET ?`,
    like,
    like,
    like,
    pageSize,
    (page - 1) * pageSize
  );
  return json({
    q,
    results: rows.map((r) => serializeThread(r, { includeBody: false })),
    pagination: { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) },
  });
});

/* auth -------------------------------------------------------------------- */
route('POST', '/api/v1/auth/register', async (ctx) => {
  const { db, env, request } = ctx;
  const iph = await ipHash(request, env);
  if (await tooManyAttempts(db, `register:${iph}`, 8, 60 * 60 * 1000)) {
    return apiError(429, 'rate_limited', '注册请求过多，请稍后再试');
  }
  await recordAttempt(db, `register:${iph}`);
  const { data, error } = await readJson(request);
  if (error) return error;

  const username = str(data.username, 40).trim();
  const email = str(data.email, 200).trim();
  const password = str(data.password, 200);
  const fields = {};
  if (!username || !USERNAME_RE.test(username)) {
    fields.username = '用户名需为 3-20 个字符，可使用中文、字母、数字、下划线或短横线';
  }
  if (!email || !EMAIL_RE.test(email)) fields.email = '请输入有效的邮箱地址';
  if (!password || password.length < 8) fields.password = '密码至少 8 个字符';
  if (Object.keys(fields).length) return apiError(400, 'validation_failed', '注册信息不完整', fields);

  const dup = await first(
    db,
    'SELECT id FROM users WHERE username_lower = ? OR email_lower = ?',
    username.toLowerCase(),
    email.toLowerCase()
  );
  if (dup) return apiError(409, 'duplicate', '用户名或邮箱已被占用');

  const iterations = iterationsFromEnv(env);
  const passwordHash = await hashPassword(password, iterations);
  const now = nowIso();
  let created;
  try {
    created = await run(
      db,
      `INSERT INTO users (username, username_lower, email, email_lower, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, 'member', ?)`,
      username,
      username.toLowerCase(),
      email,
      email.toLowerCase(),
      passwordHash,
      now
    );
  } catch (e) {
    return apiError(409, 'duplicate', '用户名或邮箱已被占用');
  }
  const userId = Number(created.lastId);
  const { token } = await createSession(db, userId);
  const user = { id: userId, username, role: 'member', created_at: now };
  return json({ token, user: publicUser(user), redirect: '/' }, 201);
});

route('POST', '/api/v1/auth/login', async (ctx) => {
  const { db, env, request } = ctx;
  const iph = await ipHash(request, env);
  if (await tooManyAttempts(db, `login:${iph}`, 12, 10 * 60 * 1000)) {
    return apiError(429, 'rate_limited', '登录尝试过多，请 10 分钟后再试');
  }
  const { data, error } = await readJson(request);
  if (error) return error;
  const login = str(data.login, 200).trim();
  const password = str(data.password, 200);
  if (!login || !password) return apiError(400, 'validation_failed', '请输入用户名与密码', { login: '必填', password: '必填' });

  const row = await first(
    db,
    'SELECT * FROM users WHERE username_lower = ? OR email_lower = ?',
    login.toLowerCase(),
    login.toLowerCase()
  );
  const ok = row ? await verifyPassword(password, row.password_hash) : false;
  if (!ok) {
    await recordAttempt(db, `login:${iph}`);
    return apiError(401, 'invalid_credentials', '用户名或密码不正确');
  }
  await run(db, 'UPDATE users SET last_seen_at = ? WHERE id = ?', nowIso(), row.id);
  const { token } = await createSession(db, Number(row.id));
  return json({
    token,
    user: publicUser(
      { id: Number(row.id), username: row.username, role: row.role, created_at: row.created_at },
      await userStats(db, Number(row.id))
    ),
    redirect: '/',
  });
});

route('POST', '/api/v1/auth/logout', async (ctx) => {
  if (!ctx.auth.user) return apiError(401, 'unauthorized', '请先登录');
  await run(ctx.env.DB, 'DELETE FROM sessions WHERE token_hash = ?', ctx.auth.tokenHash);
  return json({ ok: true });
});

route('GET', '/api/v1/auth/me', async (ctx) => {
  if (!ctx.auth.user) return apiError(401, 'unauthorized', '请先登录');
  const stats = await userStats(ctx.env.DB, ctx.auth.user.id);
  return json({ user: publicUser(ctx.auth.user, stats) });
});

/* users ------------------------------------------------------------------- */
route('GET', '/api/v1/users/:name', async (ctx) => {
  const name = String(ctx.params.name || '').toLowerCase();
  const row = await first(
    ctx.env.DB,
    `SELECT u.id, u.username, u.role, u.created_at,
            (SELECT COUNT(*) FROM threads WHERE author_id = u.id) AS thread_count,
            (SELECT COUNT(*) FROM posts WHERE author_id = u.id) AS post_count
     FROM users u WHERE u.username_lower = ?`,
    name
  );
  if (!row) return apiError(404, 'not_found', '用户不存在');
  const threads = await all(
    ctx.env.DB,
    `${THREAD_SELECT} WHERE t.author_id = ? ORDER BY t.last_post_at DESC LIMIT 50`,
    row.id
  );
  return json({
    user: {
      username: row.username,
      role: row.role,
      created_at: row.created_at,
      thread_count: Number(row.thread_count || 0),
      post_count: Number(row.post_count || 0),
    },
    threads: threads.map((t) => serializeThread(t, { includeBody: false })),
  });
});

/* new thread -------------------------------------------------------------- */
route('POST', '/api/v1/threads', async (ctx) => {
  const { db, request } = ctx;
  if (!ctx.auth.user && request.headers.has('authorization')) return apiError(401, 'invalid_token', '登录状态已失效，请重新登录');
  const actor = await resolveActor(ctx, { allowGuest: true });
  if (!actor) return apiError(503, 'guest_unavailable', '匿名发帖暂不可用，请登录后重试');
  const limitKey = actor.isGuest ? `post:ip:${await ipHash(request, ctx.env)}` : `post:${actor.userId}`;
  if (await tooManyAttempts(db, limitKey, actor.isGuest ? 10 : 20, 60 * 60 * 1000)) {
    return apiError(429, 'rate_limited', '发帖过于频繁，请稍后再试');
  }
  await recordAttempt(db, limitKey);
  const { data, error } = await readJson(request);
  if (error) return error;

  const category = str(data.category, 40).trim();
  const title = str(data.title, 120).trim();
  const body = str(data.body, 30000).trim();
  const verification = str(data.verification, 10).trim() || 'none';
  const modelCustom = str(data.model_custom ?? data.models_custom, 80).trim();
  const fields = {};

  if (!(await categoryExists(db, category))) fields.category = '请选择有效的板块';
  if (title.length < 6) fields.title = '标题至少 6 个字符';
  if (body.length < 10) fields.body = '正文至少 10 个字符';
  if (!['none', 'self'].includes(verification)) {
    fields.verification = '实机验证只能选择"未标注"或"作者自述"';
  }
  const parsed = parseModels(data.models ?? data.model_ids ?? []);
  if (parsed.error) fields.models = parsed.error;
  if (!fields.models && parsed.models.includes('other') && !modelCustom) {
    fields.model_custom = '选择了"其他"时请填写模型名称';
  }
  if (Object.keys(fields).length) return apiError(400, 'validation_failed', '发布失败：请检查表单', fields);

  const now = nowIso();
  const slug = slugify(title);
  let created;
  try {
    created = await run(
      db,
      `INSERT INTO threads (category, author_id, title, slug, body, models, model_custom, verification,
         created_at, updated_at, last_post_at, reply_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      category,
      actor.userId,
      title,
      slug,
      body,
      parsed.models.join(','),
      modelCustom,
      verification,
      now,
      now,
      now
    );
  } catch (e) {
    return apiError(500, 'db_error', '保存失败，请稍后再试');
  }
  const id = Number(created.lastId);
  const row = await first(db, `${THREAD_SELECT} WHERE t.id = ?`, id);
  return json(
    {
      thread: { ...serializeThread(row), posts: [] },
      redirect: threadPath({ id, slug }),
    },
    201
  );
});

/* reply ------------------------------------------------------------------- */
route('POST', '/api/v1/threads/:id/replies', async (ctx) => {
  const { db, request } = ctx;
  if (!ctx.auth.user && request.headers.has('authorization')) return apiError(401, 'invalid_token', '登录状态已失效，请重新登录');
  const actor = await resolveActor(ctx, { allowGuest: true });
  if (!actor) return apiError(503, 'guest_unavailable', '匿名回复暂不可用，请登录后重试');
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) return apiError(400, 'invalid_id', '主题 id 非法');
  const limitKey = actor.isGuest ? `reply:ip:${await ipHash(request, ctx.env)}` : `reply:${actor.userId}`;
  if (await tooManyAttempts(db, limitKey, actor.isGuest ? 30 : 60, 60 * 60 * 1000)) {
    return apiError(429, 'rate_limited', '回复过于频繁，请稍后再试');
  }
  await recordAttempt(db, limitKey);
  const thread = await first(db, 'SELECT id, slug, locked FROM threads WHERE id = ?', id);
  if (!thread) return apiError(404, 'not_found', '主题不存在');
  if (thread.locked) return apiError(403, 'locked', '该主题已锁定，无法回复');
  const { data, error } = await readJson(request);
  if (error) return error;
  const body = str(data.body, 20000).trim();
  if (body.length < 4) return apiError(400, 'validation_failed', '回复至少 4 个字符', { body: '太短' });
  const row = await first(db, 'SELECT COALESCE(MAX(floor), 1) AS m FROM posts WHERE thread_id = ?', id);
  const floor = Number(row?.m || 1) + 1;
  const now = nowIso();
  const created = await run(
    db,
    'INSERT INTO posts (thread_id, author_id, body, floor, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    actor.userId,
    body,
    floor,
    now
  );
  await run(
    db,
    'UPDATE threads SET reply_count = reply_count + 1, last_post_at = ?, updated_at = ? WHERE id = ?',
    now,
    now,
    id
  );
  return json(
    {
      post: {
        id: Number(created.lastId),
        floor,
        body,
        author: actor.username,
        created_at: now,
      },
      redirect: `${threadPath(thread)}#p${Number(created.lastId)}`,
    },
    201
  );
});

/* admin verify ------------------------------------------------------------ */
route('POST', '/api/v1/threads/:id/verify', async (ctx) => {
  const { db, request } = ctx;
  if (!ctx.auth.user) return apiError(401, 'unauthorized', '请先登录');
  if (ctx.auth.user.role !== 'admin') return apiError(403, 'forbidden', '只有站务可以复核实机验证');
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) return apiError(400, 'invalid_id', '主题 id 非法');
  const thread = await first(db, 'SELECT id FROM threads WHERE id = ?', id);
  if (!thread) return apiError(404, 'not_found', '主题不存在');
  const { data, error } = await readJson(request);
  if (error) return error;
  const state = str(data.verification, 10).trim();
  if (!['none', 'admin'].includes(state)) {
    return apiError(400, 'validation_failed', '复核状态只能是 admin 或 none', {
      verification: '仅站务可设置为 admin',
    });
  }
  const now = nowIso();
  await run(
    db,
    'UPDATE threads SET verification = ?, verified_at = ?, verified_by = ? WHERE id = ?',
    state,
    state === 'admin' ? now : null,
    state === 'admin' ? ctx.auth.user.id : null,
    id
  );
  const row = await first(db, `${THREAD_SELECT} WHERE t.id = ?`, id);
  return json({ thread: serializeThread(row), label: VERIFICATION_LABELS[state] });
});

/* report ------------------------------------------------------------------ */
route('POST', '/api/v1/threads/:id/report', async (ctx) => {
  if (!ctx.auth.user) return apiError(401, 'unauthorized', '请先登录');
  const id = Number(ctx.params.id);
  const { data, error } = await readJson(ctx.request);
  if (error) return error;
  const reason = str(data.reason, 1000).trim();
  if (reason.length < 4) return apiError(400, 'validation_failed', '请填写举报原因');
  const thread = await first(ctx.env.DB, 'SELECT id FROM threads WHERE id = ?', id);
  if (!thread) return apiError(404, 'not_found', '主题不存在');
  await run(
    ctx.env.DB,
    'INSERT INTO reports (target_type, target_id, reason, reporter_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    'thread',
    id,
    reason,
    ctx.auth.user.id,
    'open',
    nowIso()
  );
  return json({ ok: true });
});

/* admin console ----------------------------------------------------------- */
async function requireAdmin(ctx) {
  if (!ctx.auth.user) return apiError(401, 'unauthorized', '请先登录');
  if (ctx.auth.user.role !== 'admin') return apiError(403, 'forbidden', '需要站务权限');
  return null;
}

route('GET', '/api/v1/admin/threads', async (ctx) => {
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  const filter = (ctx.url.searchParams.get('filter') || 'all').trim();
  const where = [];
  if (filter === 'pending') where.push("t.verification = 'self'");
  if (filter === 'locked') where.push('t.locked = 1');
  if (filter === 'reported') where.push('EXISTS (SELECT 1 FROM reports r WHERE r.target_type = \'thread\' AND r.target_id = t.id AND r.status = \'open\')');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await all(
    ctx.env.DB,
    `${THREAD_SELECT} ${whereSql} ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT 100`
  );
  const openReports = await first(ctx.env.DB, "SELECT COUNT(*) AS n FROM reports WHERE status = 'open'");
  return json({ threads: rows.map((t) => serializeThread(t, { includeBody: false })), open_reports: Number(openReports?.n || 0) });
});

route('GET', '/api/v1/admin/reports', async (ctx) => {
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  const rows = await all(
    ctx.env.DB,
    `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
            u.username AS reporter, t.title AS thread_title, t.slug AS thread_slug
     FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
     LEFT JOIN threads t ON t.id = r.target_id
     ORDER BY r.status ASC, r.id DESC LIMIT 100`
  );
  return json({ reports: rows.map((r) => ({ ...r, id: Number(r.id), target_id: Number(r.target_id) })) });
});

route('POST', '/api/v1/admin/threads/:id/lock', async (ctx) => {
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) return apiError(400, 'invalid_id', '主题 id 非法');
  const { data, error } = await readJson(ctx.request);
  if (error) return error;
  const locked = data.locked ? 1 : 0;
  const info = await run(ctx.env.DB, 'UPDATE threads SET locked = ? WHERE id = ?', locked, id);
  if (!info.changes) return apiError(404, 'not_found', '主题不存在');
  return json({ ok: true, locked: Boolean(locked) });
});

route('DELETE', '/api/v1/admin/threads/:id', async (ctx) => {
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) return apiError(400, 'invalid_id', '主题 id 非法');
  await run(ctx.env.DB, 'DELETE FROM posts WHERE thread_id = ?', id);
  const info = await run(ctx.env.DB, 'DELETE FROM threads WHERE id = ?', id);
  if (!info.changes) return apiError(404, 'not_found', '主题不存在');
  await run(ctx.env.DB, "UPDATE reports SET status = 'closed' WHERE target_type = 'thread' AND target_id = ?", id);
  return json({ ok: true });
});

route('POST', '/api/v1/admin/reports/:id/close', async (ctx) => {
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  const id = Number(ctx.params.id);
  const info = await run(ctx.env.DB, "UPDATE reports SET status = 'closed' WHERE id = ?", id);
  if (!info.changes) return apiError(404, 'not_found', '举报不存在');
  return json({ ok: true });
});

/* models catalog ---------------------------------------------------------- */
route('GET', '/api/v1/models', async () =>
  json({
    models: MODELS,
    max_per_thread: MAX_MODELS_PER_THREAD,
    verification_states: [
      { id: 'none', label: VERIFICATION_LABELS.none },
      { id: 'self', label: VERIFICATION_LABELS.self },
      { id: 'admin', label: VERIFICATION_LABELS.admin },
    ],
  })
);

/* ------------------------------------------------------------------ entry */

export async function handleApi(request, env, ctx = {}) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  const url = new URL(request.url);
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (!pathname.startsWith('/api')) {
    return json({ error: 'not_found', message: '未知的 API 路径' }, 404, cors);
  }

  const { handler, params, pathMatched } = matchRoute(request.method, pathname);
  if (!handler) {
    return apiError(pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found', pathMatched ? '该地址不支持此请求方法' : '未知的 API 路径', null, cors);
  }

  try {
    const auth = await resolveAuth(request, env);
    const res = await handler({ request, env, url, params, auth, db: env.DB, ctx });
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  } catch (err) {
    console.error('[pojia-api] unhandled', err && err.stack ? err.stack : err);
    return apiError(500, 'internal_error', '服务器内部错误', null, cors);
  }
}
