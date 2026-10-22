// tests/helpers.mjs — 破甲论坛 QA 共享助手（零 npm 依赖）
// 作用：启动隔离服务进程、cookie HTTP 客户端、HTML/XML 解析、以及基于真实表单的站点探测与播种。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const QA_DIR = path.join(ROOT, '_qa');
export const PROD_DB = path.join(ROOT, 'data', 'forum.db');
mkdirSync(QA_DIR, { recursive: true });

export const NODE = process.env.QA_NODE || process.execPath;
export const EDGE =
  process.env.QA_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 隔离数据库 + 服务进程                                                */
/* ------------------------------------------------------------------ */

export function freshDb(fileName) {
  const p = path.join(QA_DIR, fileName);
  if (path.resolve(p) === path.resolve(PROD_DB)) {
    throw new Error('QA 拒绝使用生产数据库 data/forum.db');
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

export async function startServer({ port = 4310, dbFile = 'test.db', siteUrl, timeout = 45000 } = {}) {
  const dbPath = freshDb(dbFile);
  const env = {
    ...process.env,
    PORT: String(port),
    SITE_URL: siteUrl || `http://127.0.0.1:${port}`,
    DB_PATH: dbPath,
    NODE_ENV: 'test',
  };
  const child = spawn(NODE, ['server.mjs'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  let exitInfo = null;
  child.on('exit', (code, signal) => (exitInfo = { code, signal }));

  const deadline = Date.now() + timeout;
  let ready = false;
  while (Date.now() < deadline) {
    if (exitInfo) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
      if (res.status) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }

  if (!ready) {
    const detail =
      `exit=${exitInfo ? JSON.stringify(exitInfo) : 'still running'}\n` +
      `--- stdout ---\n${stdout.slice(-4000)}\n--- stderr ---\n${stderr.slice(-4000)}`;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    removeDbFiles(dbPath);
    throw new Error(
      `server.mjs 未能在端口 ${port} 就绪（可能尚未实现/启动失败）\n${detail}`,
    );
  }

  const stop = async () => {
    if (!exitInfo) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      const t0 = Date.now();
      while (!exitInfo && Date.now() - t0 < 4000) await sleep(100);
      if (!exitInfo) {
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {
          /* ignore */
        }
        await sleep(400);
      }
    }
    removeDbFiles(dbPath);
  };

  return {
    base: `http://127.0.0.1:${port}`,
    port,
    dbPath,
    child,
    stop,
    logs: () => ({ stdout, stderr }),
  };
}

/* ------------------------------------------------------------------ */
/* HTTP 客户端（手动重定向 + cookie）                                    */
/* ------------------------------------------------------------------ */

export class Client {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
    this.cookies = new Map();
  }

  abs(p) {
    return new URL(p, this.base + '/').href;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method, p, { headers = {}, body } = {}) {
    const url = this.abs(p);
    const h = {
      'user-agent': 'pojia-qa/1.0 (+integration-test)',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...headers,
    };
    const ck = this.cookieHeader();
    if (ck) h.cookie = ck;

    const res = await fetch(url, {
      method,
      headers: h,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });

    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = /max-age\s*=\s*0/i.test(sc) || /expires\s*=\s*thu, 01 jan 1970/i.test(sc);
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    const html = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      html,
      url,
      location: res.headers.get('location'),
      contentType: res.headers.get('content-type') || '',
    };
  }

  async raw(method, p, opts) {
    return this.request(method.toUpperCase(), p, opts);
  }

  async follow(p, opts = {}, maxRedirects = 8) {
    let url = this.abs(p);
    let method = (opts.method || 'GET').toUpperCase();
    let body = opts.body;
    let form = opts.form;
    const headers = { ...(opts.headers || {}) };
    const chain = [];

    for (let i = 0; i <= maxRedirects; i++) {
      let sendBody = body;
      const sendHeaders = { ...headers };
      if (form) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) {
          if (v !== undefined && v !== null) params.append(k, String(v));
        }
        sendBody = params.toString();
        sendHeaders['content-type'] = 'application/x-www-form-urlencoded';
        sendHeaders['content-length'] = String(Buffer.byteLength(sendBody));
      }
      const r = await this.request(method, url, { headers: sendHeaders, body: sendBody });
      chain.push({ url, status: r.status, location: r.location });
      if (r.status >= 300 && r.status < 400 && r.location) {
        url = new URL(r.location, url).href;
        method = 'GET';
        body = undefined;
        form = undefined;
        continue;
      }
      r.chain = chain;
      return r;
    }
    throw new Error(`重定向过多: ${p}`);
  }

  get(p) {
    return this.follow(p);
  }

  post(p, form) {
    return this.follow(p, { method: 'POST', form });
  }
}

/* ------------------------------------------------------------------ */
/* 文本 / 属性 / 标签解析                                               */
/* ------------------------------------------------------------------ */

export function decodeEntities(s = '') {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    '#39': "'",
    '#x27': "'",
    '#x2F': '/',
    '#47': '/',
  };
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
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

export function findElements(html, name) {
  const re = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    out.push({ raw: m[0], attrs: parseAttrs(m[1]), inner: m[2], index: m.index });
  }
  return out;
}

export function findVoidTags(html, name) {
  const re = new RegExp(`<${name}\\b([^>]*?)\\/?>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ raw: m[0], attrs: parseAttrs(m[1]), index: m.index });
  return out;
}

export function titleOf(html) {
  const els = findElements(html, 'title');
  return els.length === 0 ? null : textOf(els[0].inner);
}

export function titlesOf(html) {
  return findElements(html, 'title').map((e) => textOf(e.inner));
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
    if ((a.name || '').toLowerCase() === k || (a.property || '').toLowerCase() === k) {
      return a.content ?? '';
    }
  }
  return null;
}

export function linkRels(html) {
  return findVoidTags(html, 'link').map((t) => t.attrs);
}

export function canonicalOf(html) {
  const l = linkRels(html).find((a) => /(^|\s)canonical(\s|$)/i.test(a.rel || ''));
  return l ? l.href : null;
}

export function ldJsonScripts(html) {
  const out = [];
  for (const el of findElements(html, 'script')) {
    if (/application\/ld\+json/i.test(el.attrs.type || '')) out.push(el.inner.trim());
  }
  return out;
}

export function parseLdJson(html) {
  const blocks = [];
  const errors = [];
  for (const raw of ldJsonScripts(html)) {
    try {
      blocks.push(JSON.parse(raw));
    } catch (e) {
      errors.push({ raw: raw.slice(0, 200), error: String(e && e.message) });
    }
  }
  return { blocks, errors };
}

export function jsonLdTypes(blocks) {
  const types = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const t = node['@type'];
    if (typeof t === 'string') types.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walk(v);
    }
  };
  blocks.forEach(walk);
  return types;
}

export function allLinks(html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttrs(m[1]);
    const href = attrs.href;
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    let abs;
    try {
      abs = new URL(href, pageUrl).href;
    } catch {
      continue;
    }
    out.push({ href: abs, text: textOf(m[2]), attrs });
  }
  return out;
}

export function parseForms(html, pageUrl) {
  const forms = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = parseAttrs(m[1]);
    const inner = m[2];
    const fields = [];
    for (const im of inner.matchAll(/<input\b([^>]*?)\/?>/gi)) {
      const a = parseAttrs(im[1]);
      fields.push({
        tag: 'input',
        name: a.name,
        type: (a.type || 'text').toLowerCase(),
        value: a.value,
        attrs: a,
      });
    }
    for (const tm of inner.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const a = parseAttrs(tm[1]);
      fields.push({ tag: 'textarea', name: a.name, type: 'textarea', value: tm[2].trim(), attrs: a });
    }
    for (const sm of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const a = parseAttrs(sm[1]);
      const options = [...sm[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => {
        const oa = parseAttrs(o[1]);
        return {
          value: oa.value ?? textOf(o[2]),
          selected: 'selected' in oa,
          text: textOf(o[2]),
        };
      });
      fields.push({
        tag: 'select',
        name: a.name,
        type: 'select',
        value: (options.find((o) => o.selected) || options[0] || {}).value,
        options,
        attrs: a,
      });
    }
    forms.push({
      attrs,
      method: (attrs.method || 'get').toLowerCase(),
      action: attrs.action ? new URL(attrs.action, pageUrl).href : pageUrl,
      fields,
      inner,
    });
  }
  return forms;
}

export function formWithPassword(forms) {
  return forms.find((f) => f.fields.some((x) => x.type === 'password'));
}

export function fillForm(form, ctx) {
  const data = {};
  for (const f of form.fields) {
    if (!f.name) continue;
    const n = String(f.name).toLowerCase();
    if (f.type === 'hidden') {
      data[f.name] = f.value ?? '';
      continue;
    }
    if (['submit', 'button', 'reset', 'file', 'image'].includes(f.type)) continue;
    if (f.type === 'password') {
      data[f.name] = ctx.password;
      continue;
    }
    if (f.type === 'email' || /e-?mail/.test(n)) {
      data[f.name] = ctx.email;
      continue;
    }
    if (/title|subject|headline/.test(n)) {
      data[f.name] = ctx.title;
      continue;
    }
    if (/body|content|message|markdown|description|reply|comment|text/.test(n)) {
      data[f.name] = ctx.body;
      continue;
    }
    if (/user|login|nick|author|handle/.test(n)) {
      data[f.name] = ctx.username;
      continue;
    }
    if (/categor|board|forum|zone|section|tag/.test(n)) {
      data[f.name] = (f.options || []).find((o) => o.value)?.value ?? '';
      continue;
    }
    if (f.type === 'checkbox' || f.type === 'radio') {
      data[f.name] = f.value || '1';
      continue;
    }
    if (f.type === 'search' || /query|keyword|search|^q$/.test(n)) {
      data[f.name] = ctx.q ?? '测试';
      continue;
    }
    data[f.name] = f.value || ctx.username;
  }
  for (const [k, v] of Object.entries(ctx.overrides || {})) data[k] = v;
  return data;
}

/* ------------------------------------------------------------------ */
/* 站点探测 / 播种（基于真实 SSR 表单，避免猜测路由）                      */
/* ------------------------------------------------------------------ */

const AUTH_PATHS = {
  register: ['/register', '/signup', '/sign-up', '/join', '/auth/register', '/user/register'],
  login: ['/login', '/signin', '/sign-in', '/auth/login', '/user/login'],
};

const AUTH_TEXT = {
  register: /注册|创建账号|sign\s*up|register|join/i,
  login: /登录|登入|sign\s*in|log\s*in/i,
};

export async function discoverAuthPath(client, kind) {
  const home = await client.get('/');
  const links = allLinks(home.html, home.url);
  const hrefRe =
    kind === 'register'
      ? /\/(register|signup|sign-up|join|regist)/i
      : /\/(login|signin|sign-in|log-in)/i;
  for (const l of links) {
    if (AUTH_TEXT[kind].test(l.text) || hrefRe.test(new URL(l.href).pathname)) {
      const r = await client.raw('GET', l.href);
      if (r.status === 200 && /<form\b/i.test(r.html)) return l.href;
    }
  }
  for (const c of AUTH_PATHS[kind]) {
    const r = await client.raw('GET', c);
    if (r.status === 200 && /<form\b/i.test(r.html)) return c;
  }
  throw new Error(`未找到可用的${kind === 'register' ? '注册' : '登录'}页（链接与候选路径均失败）`);
}

export async function isLoggedIn(client, username) {
  const r = await client.get('/');
  const t = textOf(r.html);
  return (
    /退出|登出|注销|logout|sign\s*out/i.test(t) || (username ? t.includes(username) : false)
  );
}

export async function register(client, ctx) {
  const p = await discoverAuthPath(client, 'register');
  const page = await client.get(p);
  const form = formWithPassword(parseForms(page.html, page.url));
  if (!form) throw new Error(`注册页 ${p} 未找到含 password 的表单`);
  const data = fillForm(form, ctx);
  const res = await client.follow(form.action, { method: 'POST', form: data });
  if (res.status >= 400) {
    throw new Error(
      `注册失败 HTTP ${res.status} @ ${res.url}\n${textOf(res.html).slice(0, 600)}`,
    );
  }
  return { path: p, res };
}

export async function login(client, ctx) {
  const p = await discoverAuthPath(client, 'login');
  const page = await client.get(p);
  const form = formWithPassword(parseForms(page.html, page.url));
  if (!form) throw new Error(`登录页 ${p} 未找到含 password 的表单`);
  const data = fillForm(form, ctx);
  const res = await client.follow(form.action, { method: 'POST', form: data });
  if (res.status >= 400) {
    throw new Error(`登录失败 HTTP ${res.status} @ ${res.url}\n${textOf(res.html).slice(0, 600)}`);
  }
  return { path: p, res };
}

export async function discoverCategory(client) {
  const home = await client.get('/');
  const links = allLinks(home.html, home.url);
  const byPath = (href) => {
    try {
      return new URL(href).pathname;
    } catch {
      return '';
    }
  };
  const candidates = links.filter((l) => {
    const p = byPath(l.href);
    if (p === '/' || p === '') return false;
    return (
      /\/(c|categor(?:y|ies)|board|forum|zone|section|b|group)\//i.test(p) ||
      /分类|板块|版块|专区|category/i.test(l.text)
    );
  });
  for (const l of candidates) {
    const r = await client.raw('GET', l.href);
    if (r.status === 200 && findElements(r.html, 'h1').length > 0) {
      return { path: l.href, res: await client.get(l.href), text: l.text };
    }
  }
  for (const c of ['/categories', '/category/general', '/c/general', '/board/general', '/forum/general']) {
    const r = await client.raw('GET', c);
    if (r.status === 200 && findElements(r.html, 'h1').length > 0) return { path: c, res: await client.get(c), text: '' };
  }
  throw new Error('未找到分类页（导航链接与候选路径均失败）');
}

export async function discoverComposePath(client) {
  const home = await client.get('/');
  const links = allLinks(home.html, home.url);
  const textRe = /发帖|发布|新帖|新建主题|写帖|write|compose|new\s*(post|topic|thread)|create/i;
  const hrefRe = /\/(new|new-topic|new-post|compose|publish|submit|topics?\/new|posts?\/new|create)/i;
  const seen = new Set();
  for (const l of links) {
    const p = (() => {
      try {
        return new URL(l.href).pathname;
      } catch {
        return '';
      }
    })();
    if (!textRe.test(l.text) && !hrefRe.test(p)) continue;
    if (seen.has(l.href)) continue;
    seen.add(l.href);
    const r = await client.raw('GET', l.href);
    if ([200, 302, 303].includes(r.status)) {
      const page = await client.get(l.href);
      if (page.status === 200 && parseForms(page.html, page.url).length > 0) return { path: l.href, res: page };
    }
  }
  for (const c of [
    '/new',
    '/new-topic',
    '/new-post',
    '/compose',
    '/publish',
    '/submit',
    '/topics/new',
    '/posts/new',
    '/post/new',
  ]) {
    const page = await client.get(c);
    if (page.status === 200 && parseForms(page.html, page.url).length > 0) return { path: c, res: page };
  }
  throw new Error('未找到发帖入口（未登录用户或导航缺少“发帖”）');
}

export async function createPost(client, ctx, { composePath } = {}) {
  let comp;
  if (composePath) comp = { path: composePath, res: await client.get(composePath) };
  else comp = await discoverComposePath(client);
  const forms = parseForms(comp.res.html, comp.res.url);
  const form =
    forms.find((f) =>
      f.fields.some((x) => /title|subject|headline/.test((x.name || '').toLowerCase())),
    ) || forms.find((f) => f.fields.some((x) => x.tag === 'textarea'));
  if (!form) throw new Error(`发帖页 ${comp.path} 未找到标题/正文表单`);
  const data = fillForm(form, ctx);
  const res = await client.follow(form.action, { method: 'POST', form: data });
  if (res.status >= 400) {
    throw new Error(`发帖失败 HTTP ${res.status} @ ${res.url}\n${textOf(res.html).slice(0, 800)}`);
  }
  // 定位新帖 URL：优先最终重定向地址；否则在首页找标题链接
  const clean = (u) => String(u || '').split('#')[0].replace(/\/+$/, '');
  let postUrl = res.url;
  if (clean(postUrl) === clean(comp.res.url) || clean(postUrl).includes(clean(new URL(comp.path, client.base).pathname))) {
    const home = await client.get('/');
    const link = allLinks(home.html, home.url).find((l) => l.text.includes(ctx.title));
    if (link) postUrl = link.href;
  }
  const check = await client.get(postUrl);
  if (check.status !== 200 || !textOf(check.html).includes(ctx.title)) {
    const home = await client.get('/');
    const link = allLinks(home.html, home.url).find((l) => l.text.includes(ctx.title));
    if (link) {
      postUrl = link.href;
    }
  }
  return { url: postUrl, res, data };
}

export function findReplyForm(page) {
  const forms = parseForms(page.html, page.url);
  return (
    forms.find((f) => f.fields.some((x) => x.tag === 'textarea')) ||
    forms.find((f) =>
      f.fields.some((x) => /body|content|message|reply|comment/.test((x.name || '').toLowerCase())),
    ) ||
    null
  );
}

export async function replyToPost(client, postUrl, body, ctx) {
  const page = await client.get(postUrl);
  const form = findReplyForm(page);
  if (!form) throw new Error(`帖子页 ${postUrl} 未找到回帖表单`);
  const data = fillForm(form, { ...ctx, body });
  const res = await client.follow(form.action, { method: 'POST', form: data });
  if (res.status >= 400) {
    throw new Error(`回帖失败 HTTP ${res.status} @ ${res.url}\n${textOf(res.html).slice(0, 800)}`);
  }
  return { res, data };
}

export async function discoverSearch(client) {
  const home = await client.get('/');
  const forms = parseForms(home.html, home.url);
  const form = forms.find((f) =>
    f.fields.some(
      (x) => x.type === 'search' || /^(q|query|keyword|search)$/i.test(x.name || ''),
    ),
  );
  if (form) return { form, action: form.action };
  const link = allLinks(home.html, home.url).find((l) => /搜索|search/i.test(l.text) || /\/search/i.test(l.href));
  if (link) {
    const page = await client.get(link.href);
    if (page.status === 200) {
      const f = parseForms(page.html, page.url).find((x) =>
        x.fields.some((y) => y.type === 'search' || /^(q|query|keyword|search)$/i.test(y.name || '')),
      );
      if (f) return { form: f, action: f.action };
      return { form: null, action: link.href };
    }
  }
  return { form: null, action: '/search' };
}

export function searchUrl(search, q) {
  const url = new URL(search.action);
  const params = url.searchParams;
  const name = (search.form && search.form.fields.find((x) => x.name)?.name) || 'q';
  params.set(name, q);
  return url.href;
}

/** 注册 + 登录 + 分类 + 发帖 + 回帖，返回全链路上下文。 */
export async function seedSite(client, overrides = {}) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const ctx = {
    username: `qa_${stamp}`,
    password: 'QaPassw0rd!2026',
    email: `qa_${stamp}@example.test`,
    title: `QA 验收帖 ${stamp}`,
    body: `这是 QA 自动化验收正文 ${stamp}，包含中文与 ASCII marker: qa-body-marker-${stamp}。`,
    ...overrides,
  };
  await register(client, ctx);
  await login(client, ctx);
  const category = await discoverCategory(client);
  const post = await createPost(client, ctx);
  ctx.replyText = `QA 回帖内容 ${stamp} marker reply-${stamp}`;
  await replyToPost(client, post.url, ctx.replyText, ctx);
  return { ctx, category, post, stamp };
}

/* ------------------------------------------------------------------ */
/* 契约优先的流程助手（据 Lead 提供的接口契约实现）                        */
/* ------------------------------------------------------------------ */

export const CATEGORIES = ['jailbreak', 'injection', 'redteam', 'defense', 'tooling', 'vuln', 'general'];
export const DEFAULT_CATEGORY = 'jailbreak';

export function makeCtx(prefix = 'qa', overrides = {}) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    stamp,
    username: `${prefix}_${stamp}`,
    password: 'QaPassw0rd!2026',
    email: `${prefix}_${stamp}@example.test`,
    title: `QA 验收帖 ${stamp}`,
    body: `这是 QA 自动化验收正文 ${stamp}，包含中文与 marker: qa-body-marker-${stamp}。`,
    ...overrides,
  };
}

export async function postFormOnce(client, p, form) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (v !== undefined && v !== null) body.append(k, String(v));
  }
  return client.raw('POST', p, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

export function csrfFrom(html) {
  const m =
    String(html).match(/name=["']_csrf["'][^>]*value=["']([^"']+)["']/i) ||
    String(html).match(/value=["']([^"']+)["'][^>]*name=["']_csrf["']/i);
  return m ? m[1] : null;
}

export async function registerViaContract(client, ctx) {
  const page = await client.get('/register');
  if (page.status !== 200) throw new Error(`GET /register -> ${page.status} (期望 200)`);
  const form = formWithPassword(parseForms(page.html, page.url));
  if (!form) throw new Error('GET /register 页面未找到含 password 的表单');
  const csrf = csrfFrom(page.html) || form.fields.find((f) => f.name === '_csrf')?.value;
  if (!csrf) throw new Error('GET /register 页面未找到 _csrf hidden 字段');
  // 用真实表单填充以带上 accept/next 等必填项
  const data = fillForm(form, { ...ctx });
  data._csrf = csrf;
  const res = await postFormOnce(client, form.action || '/register', data);
  return { page, res, csrf, data };
}

export async function loginViaContract(client, ctx) {
  const page = await client.get('/login');
  if (page.status !== 200) throw new Error(`GET /login -> ${page.status} (期望 200)`);
  const form = formWithPassword(parseForms(page.html, page.url));
  if (!form) throw new Error('GET /login 页面未找到含 password 的表单');
  const csrf = csrfFrom(page.html) || form.fields.find((f) => f.name === '_csrf')?.value;
  if (!csrf) throw new Error('GET /login 页面未找到 _csrf hidden 字段');
  const data = fillForm(form, { ...ctx });
  data._csrf = csrf;
  if (form.fields.some((f) => f.name === 'login')) data.login = ctx.username;
  const res = await postFormOnce(client, form.action || '/login', data);
  return { page, res, csrf, data };
}

export async function createPostViaContract(client, ctx, { category = DEFAULT_CATEGORY } = {}) {
  const page = await client.get(`/new?category=${encodeURIComponent(category)}`);
  if (page.status !== 200) {
    throw new Error(`GET /new?category=${category} -> ${page.status} ${page.location || ''}（期望 200）`);
  }
  const csrf = csrfFrom(page.html);
  if (!csrf) throw new Error('GET /new 页面未找到 _csrf hidden 字段');
  const form = parseForms(page.html, page.url).find((f) =>
    f.fields.some((x) => /title|subject|headline/.test((x.name || '').toLowerCase())),
  );
  const data = form ? fillForm(form, { ...ctx }) : { category, title: ctx.title, body: ctx.body };
  data.category = category;
  data.title = ctx.title;
  data.body = ctx.body;
  data._csrf = csrf;
  const res = await postFormOnce(client, form?.action || '/new', data);
  if (res.status !== 303) {
    throw new Error(
      `POST /new -> ${res.status}（期望 303）\n${textOf(res.html).slice(0, 800)}`,
    );
  }
  const location = res.location || '';
  const postUrl = new URL(location, client.base).href;
  return { page, res, location, postUrl, postPath: new URL(postUrl).pathname, csrf, data };
}

export async function replyViaContract(client, postPathOrUrl, body, ctx) {
  const postUrl = new URL(postPathOrUrl, client.base).href;
  const page = await client.get(postUrl);
  if (page.status !== 200) throw new Error(`GET ${postUrl} -> ${page.status}`);
  const csrf = csrfFrom(page.html);
  if (!csrf) throw new Error('帖子页未找到回帖表单的 _csrf hidden 字段');
  const form = parseForms(page.html, page.url).find(
    (f) =>
      f.attrs.action &&
      /\/reply\b/.test(f.attrs.action) &&
      f.fields.some((x) => /body|content|message|reply|comment/.test((x.name || '').toLowerCase())),
  );
  const id = new URL(postUrl).pathname.match(/\/t\/(\d+)/)?.[1];
  if (!id) throw new Error(`帖子 URL 不符合 /t/:id-slug: ${postUrl}`);
  const data = form ? fillForm(form, { ...ctx, body }) : { body };
  data.body = body;
  data._csrf = csrf;
  const res = await postFormOnce(client, form?.attrs.action || `/t/${id}/reply`, data);
  return { page, res, replyUrl: new URL(res.location || postUrl, client.base).href };
}

export async function seedViaContract(client, overrides = {}) {
  const ctx = makeCtx('qa', overrides);
  const registration = await registerViaContract(client, ctx);
  const login = await loginViaContract(client, ctx);
  const post = await createPostViaContract(client, ctx);
  ctx.replyText = `QA 回帖内容 marker reply-${ctx.stamp}`;
  const reply = await replyViaContract(client, post.postPath, ctx.replyText, ctx);
  return { ctx, post, reply, registration, login };
}

/* ------------------------------------------------------------------ */
/* 断言辅助                                                             */
/* ------------------------------------------------------------------ */

export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return String(u);
  }
}

export function locsOf(xml) {
  return [...String(xml).matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) =>
    decodeEntities(m[1]).trim(),
  );
}

export function countMatches(str, re) {
  return [...String(str).matchAll(re)].length;
}
