// tests/helpers.mjs — 破甲论坛 v2 QA 共享助手（后端 API / SSG 构建 / 静态解析）
// 契约来源：pojia-forum/ARCHITECTURE.md（v2）。零 npm 依赖。
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const QA_DIR = path.join(ROOT, '_qa');
export const NODE = process.env.QA_NODE || process.execPath;
export const EDGE =
  process.env.QA_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

mkdirSync(QA_DIR, { recursive: true });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 隔离数据库 / 进程                                                    */
/* ------------------------------------------------------------------ */

export function freshDb(fileName) {
  const p = path.join(QA_DIR, fileName);
  if (!path.resolve(p).startsWith(path.resolve(QA_DIR))) {
    throw new Error(`测试数据库必须位于 _qa/ 内，拒绝 ${p}`);
  }
  removeDbFiles(p);
  return p;
}

export function removeDbFiles(p) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      rmSync(p + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function tail(str, n = 4000) {
  return String(str).slice(-n);
}

async function waitForHttp(url, child, getLogs, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let exited = null;
  if (child) child.on('exit', (code, signal) => (exited = { code, signal }));
  while (Date.now() < deadline) {
    if (exited) {
      const logs = getLogs();
      throw new Error(
        `进程提前退出: ${JSON.stringify(exited)}\n--- stdout ---\n${tail(logs.stdout)}\n--- stderr ---\n${tail(logs.stderr)}`,
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status) return res;
    } catch {
      /* not up */
    }
    await sleep(150);
  }
  const logs = getLogs();
  throw new Error(
    `等待 ${url} 超时（${timeout}ms）\n--- stdout ---\n${tail(logs.stdout)}\n--- stderr ---\n${tail(logs.stderr)}`,
  );
}

function spawnTracked(args, opts) {
  const child = spawn(NODE, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...opts,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const state = { exitInfo: null };
  child.on('exit', (code, signal) => (state.exitInfo = { code, signal }));
  return { child, state, logs: () => ({ stdout, stderr }) };
}

async function killChild(child, state) {
  if (!state.exitInfo) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    const t0 = Date.now();
    while (!state.exitInfo && Date.now() - t0 < 4000) await sleep(100);
    if (!state.exitInfo) {
      try {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        /* ignore */
      }
      await sleep(400);
    }
  }
}

/** 启动本地后端（同一份 Worker 代码 + node:sqlite D1 shim）。 */
export async function startApi({ port = 4410, dbFile = 'api-test.db', env = {}, timeout = 45000 } = {}) {
  const dbPath = freshDb(dbFile);
  const base = `http://127.0.0.1:${port}`;
  const t = spawnTracked([path.join('backend', 'local-server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      APP_SECRET: `qa-secret-${port}-${Date.now()}`,
      ALLOWED_ORIGINS: '*',
      NODE_ENV: 'test',
      ...env,
    },
  });
  await waitForHttp(`${base}/api/health`, t.child, t.logs, timeout);
  return {
    base,
    baseApi: `${base}/api/v1`,
    dbPath,
    logs: t.logs,
    stop: async () => {
      await killChild(t.child, t.state);
      removeDbFiles(dbPath);
    },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP / API JSON 客户端                                               */
/* ------------------------------------------------------------------ */

export async function apiFetch(baseUrl, method, p, { token, body, headers = {} } = {}) {
  const clean = baseUrl.replace(/\/+$/, '');
  let url;
  if (/^https?:/i.test(p)) {
    url = p;
  } else {
    const pathPart = p.startsWith('/') ? p : `/${p}`;
    // 自动补 /api/v1 前缀（/api/health 等显式 API 路径保持原样）
    if (clean.endsWith('/api/v1') || pathPart.startsWith('/api/')) url = clean + pathPart;
    else url = `${clean}/api/v1${pathPart}`;
  }
  const h = { accept: 'application/json', ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers: h,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return {
    status: res.status,
    headers: res.headers,
    text,
    json,
    contentType: res.headers.get('content-type') || '',
  };
}

export async function registerApi(apiBase, user, { expectStatus = 201 } = {}) {
  const res = await apiFetch(apiBase, 'POST', '/auth/register', { body: user });
  if (expectStatus != null && res.status !== expectStatus) {
    throw new Error(
      `POST /auth/register -> ${res.status}（期望 ${expectStatus}）\n${res.text.slice(0, 600)}`,
    );
  }
  return res;
}

export async function loginApi(apiBase, login, password, { expectStatus = 200 } = {}) {
  const res = await apiFetch(apiBase, 'POST', '/auth/login', { body: { login, password } });
  if (expectStatus != null && res.status !== expectStatus) {
    throw new Error(`POST /auth/login -> ${res.status}（期望 ${expectStatus}）\n${res.text.slice(0, 600)}`);
  }
  return res;
}

export function makeUser(prefix = 'qa', overrides = {}) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    stamp,
    username: `${prefix}_${stamp}`,
    email: `${prefix}_${stamp}@example.test`,
    password: 'QaPassw0rd!2026',
    ...overrides,
  };
}

export async function createThreadApi(apiBase, token, payload, { expectStatus = 201 } = {}) {
  const res = await apiFetch(apiBase, 'POST', '/threads', { token, body: payload });
  if (expectStatus != null && res.status !== expectStatus) {
    throw new Error(
      `POST /threads -> ${res.status}（期望 ${expectStatus}）\n${res.text.slice(0, 800)}`,
    );
  }
  return res;
}

/** 播种一组真实数据：用户、不同板块主题（含模型/验证标注与无标注降级样本）、回复。 */
export async function seedForum(apiBase, { categories = ['jailbreak', 'injection', 'redteam', 'general'] } = {}) {
  const user = makeUser('qa');
  const reg = await registerApi(apiBase, user);
  const token = reg.json.token;
  const userObj = reg.json.user;

  const stamp = user.stamp;
  const threads = [];
  const specs = [
    {
      category: categories[0],
      title: `越狱提示词鲁棒性评估 ${stamp}`,
      body: `这是 SSG 验收正文 ${stamp}。我们在自有模型上做白盒越狱评估，记录基线、扰动与拒绝率。\n\nmarker-${stamp}-alpha`,
      models: ['gpt', 'claude'],
      verification: 'self',
    },
    {
      category: categories[1],
      title: `间接提示词注入路径梳理 ${stamp}`,
      body: `这是注入方向正文 ${stamp}，覆盖工具调用场景与数据外带路径。marker-${stamp}-beta`,
      models: ['claude'],
      verification: 'none',
    },
    {
      category: categories[2],
      title: `未标注模型的普通讨论 ${stamp}`,
      body: `不标注模型与验证等级的降级样本 ${stamp}。marker-${stamp}-gamma`,
      models: [],
      verification: 'none',
    },
  ];
  for (const spec of specs) {
    const res = await createThreadApi(apiBase, token, spec);
    threads.push(res.json.thread);
  }
  const reply = await apiFetch(apiBase, 'POST', `/threads/${threads[0].id}/replies`, {
    token,
    body: { body: `SSG 验收回帖 ${stamp}，marker-${stamp}-reply` },
  });
  return {
    user: { ...user, ...userObj },
    token,
    threads,
    reply,
    stamp,
    markers: {
      alpha: `marker-${stamp}-alpha`,
      beta: `marker-${stamp}-beta`,
      gamma: `marker-${stamp}-gamma`,
      reply: `marker-${stamp}-reply`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* SSG 构建                                                             */
/* ------------------------------------------------------------------ */

/**
 * 构建静态站。契约（ARCHITECTURE.md）：node frontend/build.mjs --api <API_BASE> --site <SITE_URL>
 * 输出目录通过 --out 指定；若构建器不识别 --out，会回退到 frontend/dist（由调用方串行处理）。
 */
export async function buildDist({ apiBase, siteUrl, outDir, extraArgs = [], timeout = 180000 } = {}) {
  if (!existsSync(path.join(ROOT, 'frontend', 'build.mjs'))) {
    throw new Error('frontend/build.mjs 不存在（站点尚未就绪）');
  }
  if (outDir) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
  }
  const args = [path.join('frontend', 'build.mjs'), '--api', apiBase, '--site', siteUrl];
  if (outDir) args.push('--out', outDir);
  args.push(...extraArgs);
  const t = spawnTracked(args, {
    env: {
      ...process.env,
      API_BASE: apiBase,
      SITE_URL: siteUrl,
      ...(outDir ? { OUT_DIR: outDir, DIST_DIR: outDir } : {}),
    },
  });
  const deadline = Date.now() + timeout;
  while (!t.state.exitInfo && Date.now() < deadline) await sleep(150);
  if (!t.state.exitInfo) {
    await killChild(t.child, t.state);
    throw new Error(`frontend/build.mjs 构建超时（${timeout}ms）\n${tail(t.logs().stderr)}`);
  }
  const { stdout, stderr } = t.logs();
  if (t.state.exitInfo.code !== 0) {
    throw new Error(
      `frontend/build.mjs 构建失败 code=${t.state.exitInfo.code}\n--- stdout ---\n${tail(stdout)}\n--- stderr ---\n${tail(stderr)}`,
    );
  }
  const dir = outDir || path.join(ROOT, 'frontend', 'dist');
  if (!existsSync(path.join(dir, 'index.html'))) {
    throw new Error(
      `构建完成但 ${path.relative(ROOT, dir)}/index.html 不存在\n--- stdout ---\n${tail(stdout)}\n--- stderr ---\n${tail(stderr)}`,
    );
  }
  return { dir, stdout, stderr };
}

export function walkFiles(dir, base = dir) {
  const out = [];
  const visit = (cur) => {
    for (const name of readdirSync(cur)) {
      const full = path.join(cur, name);
      const st = statSync(full);
      if (st.isDirectory()) visit(full);
      else out.push({ abs: full, rel: path.relative(base, full).split(path.sep).join('/'), size: st.size });
    }
  };
  visit(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function readText(file) {
  return readFileSync(file, 'utf8');
}

/* ------------------------------------------------------------------ */
/* HTML / XML / 文本解析（无 npm 依赖）                                 */
/* ------------------------------------------------------------------ */

export function decodeEntities(s = '') {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const num = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : m;
    }
    return named[code] !== undefined ? named[code] : m;
  });
}

export function stripTags(html = '') {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

export function textOf(html = '') {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

export function parseAttrs(str = '') {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(str))) {
    const name = m[1].toLowerCase();
    if (name === '/' || name === '') continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function findElements(html, name) {
  const re = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ raw: m[0], attrs: parseAttrs(m[1]), inner: m[2], index: m.index });
  return out;
}

export function findVoidTags(html, name) {
  const re = new RegExp(`<${name}\\b([^>]*?)\\/?>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ raw: m[0], attrs: parseAttrs(m[1]), index: m.index });
  return out;
}

export function titlesOf(html) {
  return findElements(html, 'title').map((e) => textOf(e.inner));
}

export function titleOf(html) {
  const t = titlesOf(html);
  return t.length ? t[0] : null;
}

export function h1s(html) {
  return findElements(html, 'h1').map((e) => textOf(e.inner));
}

export function metas(html) {
  return findVoidTags(html, 'meta').map((t) => t.attrs);
}

export function metaContent(html, key) {
  const k = String(key).toLowerCase();
  for (const a of metas(html)) {
    if ((a.name || '').toLowerCase() === k || (a.property || '').toLowerCase() === k) return a.content ?? '';
  }
  return null;
}

export function canonicalOf(html) {
  const l = findVoidTags(html, 'link')
    .map((t) => t.attrs)
    .find((a) => /(^|\s)canonical(\s|$)/i.test(a.rel || ''));
  return l ? l.href : null;
}

export function parseLdJson(html) {
  const blocks = [];
  const errors = [];
  for (const el of findElements(html, 'script')) {
    if (!/application\/ld\+json/i.test(el.attrs.type || '')) continue;
    try {
      blocks.push(JSON.parse(el.inner.trim()));
    } catch (e) {
      errors.push({ raw: el.inner.trim().slice(0, 200), error: String(e && e.message) });
    }
  }
  return { blocks, errors };
}

export function jsonLdTypes(blocks) {
  const types = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const t = node['@type'];
    if (typeof t === 'string') types.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  blocks.forEach(walk);
  return types;
}

export function allLinks(html, pageUrlForResolve = 'http://localhost/') {
  const out = [];
  for (const m of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttrs(m[1]);
    const href = attrs.href;
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    let abs = null;
    try {
      abs = new URL(href, pageUrlForResolve).href;
    } catch {
      /* keep null */
    }
    out.push({ href, abs, text: textOf(m[2]), attrs });
  }
  return out;
}

export function locsOf(xml) {
  return [...String(xml).matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]).trim());
}

export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return String(u);
  }
}

/* ------------------------------------------------------------------ */
/* 静态产物辅助                                                         */
/* ------------------------------------------------------------------ */

/** 将页面内链接映射到 dist 内的文件路径；不存在返回 null。 */
export function resolveStaticFile(distDir, pageRelFile, href) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return null;
  const pageDir = path.posix.dirname(pageRelFile.split(path.sep).join('/'));
  const target = href.split('#')[0].split('?')[0];
  if (!target) return pageRelFile;
  let resolved;
  if (target.startsWith('/')) resolved = target.replace(/^\/+/, '');
  else resolved = path.posix.normalize(path.posix.join(pageDir, target));

  const candidates = [];
  if (resolved.endsWith('/') || resolved === '.') {
    candidates.push(path.posix.join(resolved, 'index.html'));
  } else {
    candidates.push(resolved);
    candidates.push(`${resolved}/index.html`);
    candidates.push(`${resolved}.html`);
  }
  for (const c of candidates) {
    const full = path.join(distDir, c);
    if (existsSync(full) && statSync(full).isFile()) return c.split(path.sep).join('/');
  }
  return null;
}

/** 把双前端产物中的域名/API 地址归一化，用于逐字节比较。 */
export function normalizeBuildText(text, { siteUrl, apiBase } = {}) {
  let out = String(text);
  if (siteUrl) {
    const site = siteUrl.replace(/\/+$/, '');
    out = out.split(site).join('__SITE__');
    try {
      out = out.split(new URL(site).origin).join('__SITE_ORIGIN__');
    } catch {
      /* ignore */
    }
  }
  if (apiBase) {
    const api = apiBase.replace(/\/+$/, '');
    out = out.split(api).join('__API__');
    try {
      out = out.split(new URL(api).origin).join('__API_ORIGIN__');
    } catch {
      /* ignore */
    }
  }
  // assets/config.js 允许 siteUrl/apiBase/base 三项配置不同（占位符归一化）
  out = out.replace(/("?(?:siteUrl|apiBase|base)"?\s*:\s*")[^"]*(")/g, '$1__CFG__$2');
  return out;
}

/** 取 SITE_URL 的 base 路径（GitHub Pages 项目子路径），统一成以 / 结尾。 */
export function basePathOf(siteUrl) {
  try {
    const p = new URL(siteUrl).pathname;
    return p.endsWith('/') ? p : `${p}/`;
  } catch {
    return '/';
  }
}

/** 仅用于 404.html：把 root-relative 的 base 路径归一化（404 需要绝对 base 才能定位资源）。 */
export function normalizeBaseAware(text, basePath) {
  const bp = basePath === '/' ? '/' : basePath;
  const esc = bp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text)
    .replace(new RegExp(`(href|src)="${esc}`, 'g'), '$1="/__BASE__/')
    .replace(/(href|src)="\/__BASE__\/__BASE__\//g, '$1="/__BASE__/');
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
