// tests/visual-shots.mjs — 视觉验收 v2：构建静态站 → 本地静态服务 → 无头 Edge(CDP) 截图 + 布局度量
// 用法：node tests/visual-shots.mjs
// 产物：_qa/{desktop|mobile}-{home,category,thread}.png + _qa/shots.json（含横向溢出/导航可见性度量）
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  QA_DIR,
  EDGE,
  NODE,
  startApi,
  seedForum,
  apiFetch,
  buildDist,
  walkFiles,
  sleep,
} from './helpers.mjs';

const API_PORT = 4414;
const STATIC_PORT = 4424;
const DEBUG_PORT = 9333;
const DIST = path.join(QA_DIR, 'dist-visual');
const OUT = QA_DIR;
const PROFILE = path.join(QA_DIR, `edge-cdp-profile-${process.pid}`);
const SHOTS = [
  { tag: 'desktop', width: 1440, height: 900, pages: ['home', 'category', 'thread', 'new', 'category-new'] },
  { tag: 'mid', width: 1180, height: 900, pages: ['home'] },
  { tag: 'tablet', width: 900, height: 900, pages: ['home'] },
  { tag: 'mobile', width: 390, height: 844, pages: ['home', 'category', 'thread', 'new', 'category-new'] },
];
mkdirSync(OUT, { recursive: true });

/* ------------------------- 静态文件服务器 ------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function startStaticServer(dir, port) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const direct = path.join(dir, p);
    let file = null;
    if (existsSync(direct) && statSync(direct).isFile()) {
      file = direct;
    } else {
      const alt = path.join(dir, p, 'index.html');
      const html = path.join(dir, `${p}.html`);
      if (existsSync(alt) && statSync(alt).isFile()) file = alt;
      else if (existsSync(html) && statSync(html).isFile()) file = html;
    }
    if (!file) {
      const nf = path.join(dir, '404.html');
      if (existsSync(nf)) {
        res.writeHead(404, { 'content-type': MIME['.html'] });
        res.end(readFileSync(nf));
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* ------------------------- 极简 CDP 客户端 ------------------------- */

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async open() {
    if (this.ws.readyState === 1) return;
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
        return;
      }
      const arr = this.handlers.get(msg.sessionId || '');
      if (arr && msg.method) for (const fn of arr) fn(msg);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时 ${method}`));
        }
      }, 30000);
    });
  }

  waitEvent(sessionId, method, timeout = 20000) {
    return new Promise((res, rej) => {
      let arr = this.handlers.get(sessionId);
      if (!arr) {
        arr = [];
        this.handlers.set(sessionId, arr);
      }
      const fn = (msg) => {
        if (msg.method !== method) return;
        cleanup();
        res(msg.params);
      };
      const cleanup = () => {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        cleanup();
        rej(new Error(`等待事件超时 ${method}`));
      }, timeout);
      arr.push(fn);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitJson(url, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch {
      /* not up */
    }
    await sleep(200);
  }
  throw new Error(`等待 ${url} 超时`);
}

/* ------------------------- 度量表达式 ------------------------- */

const METRICS_EXPR = `(() => {
  const vw = window.innerWidth;
  const se = document.scrollingElement || document.documentElement;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    if (r.right > vw + 1 || r.left < -1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 80),
        left: Math.round(r.left),
        right: Math.round(r.right),
      });
      if (offenders.length >= 15) break;
    }
  }
  const visible = (sel) => [...document.querySelectorAll(sel)].filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }).length;
  const header = document.querySelector('header');
  const sideNav = document.querySelector('.side-nav');
  const sideNavInfo = sideNav
    ? {
        exists: true,
        overflowX: getComputedStyle(sideNav).overflowX,
        scrollWidth: sideNav.scrollWidth,
        clientWidth: sideNav.clientWidth,
        height: Math.round(sideNav.getBoundingClientRect().height),
      }
    : { exists: false };
  return JSON.stringify({
    title: document.title,
    h1: (document.querySelector('h1') || {}).textContent || '',
    page: document.body.dataset.page || '',
    vw,
    vh: window.innerHeight,
    scrollWidth: se.scrollWidth,
    clientWidth: se.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    horizontalOverflow: se.scrollWidth > se.clientWidth + 1,
    offenders,
    navLinks: visible('header a, nav a'),
    formCount: document.querySelectorAll('form').length,
    threadList: document.querySelectorAll('.thread-list, .thread-row, .thread-item').length,
    fallback: (() => {
      const box = document.querySelector('[data-dynamic-fallback]');
      if (!box) return null;
      return { hidden: box.hasAttribute('hidden'), text: String(box.innerText || '').slice(0, 600) };
    })(),
    sideNav: sideNavInfo,
    headerHeight: header ? Math.round(header.getBoundingClientRect().height) : 0,
    fontFamily: getComputedStyle(document.body).fontFamily,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
  });
})()`;

/* ------------------------- 主流程 ------------------------- */

async function main() {
  if (!existsSync(EDGE)) throw new Error(`未找到 Edge: ${EDGE}`);
  if (!existsSync(path.join(ROOT, 'frontend', 'build.mjs'))) {
    throw new Error('frontend/build.mjs 不存在，站点未就绪');
  }

  const srv = await startApi({ port: API_PORT, dbFile: 'visual-test.db' });
  let server;
  let edge;
  const results = [];
  const extraResults = [];
  try {
    const seed = await seedForum(srv.base);
    await buildDist({ apiBase: srv.base, siteUrl: `http://127.0.0.1:${STATIC_PORT}`, outDir: DIST });
    const files = walkFiles(DIST);
    const threadFile = files.find((f) => /^t\/\d+-[^/]+\/index\.html$/.test(f.rel));
    if (!threadFile) throw new Error('dist 中缺少主题详情页');
    const catFile = files.find((f) => /^c\/[^/]+\/index\.html$/.test(f.rel));
    if (!catFile) throw new Error('dist 中缺少分类页');
    const catSlug = catFile.rel.split('/')[1];

    server = await startStaticServer(DIST, STATIC_PORT);
    const pageMap = {
      home: { name: 'home', path: '/' },
      category: { name: 'category', path: `/c/${catSlug}/` },
      thread: { name: 'thread', path: `/${threadFile.rel.replace(/\/index\.html$/, '/')}` },
      new: { name: 'new', path: '/new/' },
      'category-new': { name: 'category-new', path: '/category/new/' },
    };

    edge = spawn(
      EDGE,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${PROFILE}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let edgeErr = '';
    edge.stderr.on('data', (d) => (edgeErr += d));

    const version = await waitJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();

    for (const vp of SHOTS) {
      for (const pageName of vp.pages) {
        const page = pageMap[pageName];
        if (!page) throw new Error(`未知页面 ${pageName}`);
        const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const sid = attached.sessionId;
        await cdp.send('Page.enable', {}, sid);
        await cdp.send('Runtime.enable', {}, sid);
        await cdp.send(
          'Emulation.setDeviceMetricsOverride',
          { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.width < 600 },
          sid,
        );
        const loaded = cdp.waitEvent(sid, 'Page.loadEventFired', 25000).catch(() => null);
        await cdp.send('Page.navigate', { url: `http://127.0.0.1:${STATIC_PORT}${page.path}` }, sid);
        await loaded;
        await sleep(700);

        const evalRes = await cdp.send('Runtime.evaluate', { expression: METRICS_EXPR, returnByValue: true }, sid);
        let metrics = null;
        try {
          metrics = JSON.parse(evalRes.result.value);
        } catch {
          metrics = { error: 'metrics parse failed' };
        }

        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
        const outPath = path.join(OUT, `${vp.tag}-${page.name}.png`);
        writeFileSync(outPath, Buffer.from(shot.data, 'base64'));

        const needsForm = page.name === 'new' || page.name === 'category-new';
        const pass =
          Boolean(metrics) &&
          metrics.horizontalOverflow === false &&
          metrics.scrollWidth <= vp.width + 1 &&
          metrics.navLinks > 0 &&
          (!needsForm || metrics.formCount >= 1) &&
          existsSync(outPath) &&
          readFileSync(outPath).length > 5000;

        results.push({
          viewport: `${vp.width}x${vp.height}`,
          page: page.name,
          url: `http://127.0.0.1:${STATIC_PORT}${page.path}`,
          screenshot: path.relative(ROOT, outPath).split(path.sep).join('/'),
          metrics,
          PASS: pass,
        });
        console.log(
          `[${pass ? 'PASS' : 'FAIL'}] ${vp.tag}-${page.name} ${vp.width}x${vp.height} ` +
            `scroll=${metrics?.scrollWidth}/${metrics?.clientWidth} overflow=${metrics?.horizontalOverflow} ` +
            `nav=${metrics?.navLinks} h1=${JSON.stringify(metrics?.h1 || '').slice(0, 32)} ` +
            `sideNav=${metrics?.sideNav?.exists ? `${metrics.sideNav.overflowX}/${metrics.sideNav.scrollWidth}>${metrics.sideNav.clientWidth}` : 'none'} ` +
            `forms=${metrics?.formCount}`,
        );

        await cdp.send('Target.closeTarget', { targetId: target.targetId });
      }
    }

    // 附加诊断：宽屏/1366 首页，检查全宽布局左右边距（不计入主 PASS 计数）
    for (const extra of [
      { tag: 'wide', width: 1600, height: 900, page: 'home' },
      { tag: 'small', width: 1366, height: 900, page: 'home' },
    ]) {
      const page = pageMap[extra.page];
      const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const sid = attached.sessionId;
      await cdp.send('Page.enable', {}, sid);
      await cdp.send('Runtime.enable', {}, sid);
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: extra.width, height: extra.height, deviceScaleFactor: 1, mobile: false },
        sid,
      );
      const loaded = cdp.waitEvent(sid, 'Page.loadEventFired', 25000).catch(() => null);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${STATIC_PORT}${page.path}` }, sid);
      await loaded;
      await sleep(700);
      const evalRes = await cdp.send('Runtime.evaluate', { expression: METRICS_EXPR, returnByValue: true }, sid);
      let metrics = null;
      try {
        metrics = JSON.parse(evalRes.result.value);
      } catch {
        metrics = { error: 'metrics parse failed' };
      }
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
      const outPath = path.join(OUT, `${extra.tag}-${page.name}.png`);
      writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
      extraResults.push({
        viewport: `${extra.width}x${extra.height}`,
        page: page.name,
        screenshot: path.relative(ROOT, outPath).split(path.sep).join('/'),
        metrics,
        note: '宽屏边距诊断（不计入主 PASS 计数）',
      });
      console.log(
        `[extra] ${extra.tag}-${page.name} ${extra.width}x${extra.height} ` +
          `scroll=${metrics?.scrollWidth}/${metrics?.clientWidth} overflow=${metrics?.horizontalOverflow} ` +
          `h1=${JSON.stringify(metrics?.h1 || '').slice(0, 40)}`,
      );
      await cdp.send('Target.closeTarget', { targetId: target.targetId });
    }

    // 新需求：未进入静态构建的新板块，404.html 由 client/app.js 实时兜底渲染
    const dynName = `兜底板块${Date.now().toString(36).slice(-4)}`.slice(0, 20);
    const dynRes = await apiFetch(srv.base, 'POST', '/categories', {
      token: seed.token,
      body: { name: dynName, description: '动态兜底验收' },
    });
    if (dynRes.status === 201) {
      const dynSlug = dynRes.json.category.slug;
      for (const vp of [
        { tag: 'fallback', width: 1440, height: 900 },
        { tag: 'fallback-mobile', width: 390, height: 844 },
      ]) {
        const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const sid = attached.sessionId;
        await cdp.send('Page.enable', {}, sid);
        await cdp.send('Runtime.enable', {}, sid);
        await cdp.send(
          'Emulation.setDeviceMetricsOverride',
          { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.width < 600 },
          sid,
        );
        const loaded = cdp.waitEvent(sid, 'Page.loadEventFired', 25000).catch(() => null);
        await cdp.send('Page.navigate', { url: `http://127.0.0.1:${STATIC_PORT}/c/${dynSlug}/` }, sid);
        await loaded;
        await sleep(1500);
        const evalRes = await cdp.send('Runtime.evaluate', { expression: METRICS_EXPR, returnByValue: true }, sid);
        let metrics = null;
        try {
          metrics = JSON.parse(evalRes.result.value);
        } catch {
          metrics = { error: 'metrics parse failed' };
        }
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
        const outPath = path.join(OUT, `${vp.tag}-category.png`);
        writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
        const rendered = Boolean(
          metrics?.fallback && !metrics.fallback.hidden && metrics.fallback.text.includes(dynName),
        );
        const pass = rendered && metrics?.horizontalOverflow === false;
        extraResults.push({
          viewport: `${vp.width}x${vp.height}`,
          page: 'dynamic-category',
          url: `/c/${dynSlug}/`,
          screenshot: path.relative(ROOT, outPath).split(path.sep).join('/'),
          metrics,
          dynamicFallback: { name: dynName, slug: dynSlug, rendered },
          PASS: pass,
          note: '新板块动态兜底渲染（不计入主 PASS 计数）',
        });
        console.log(
          `[extra] ${vp.tag}-dynamic-category ${vp.width}x${vp.height} rendered=${rendered} ` +
            `fallbackText=${JSON.stringify(metrics?.fallback?.text || '').slice(0, 80)}`,
        );
        await cdp.send('Target.closeTarget', { targetId: target.targetId });
      }
    } else {
      extraResults.push({
        page: 'dynamic-category',
        error: `POST /categories -> ${dynRes.status}`,
        PASS: false,
        note: '新板块动态兜底渲染（不计入主 PASS 计数）',
      });
      console.log(`[extra] dynamic-category FAIL: 创建板块返回 ${dynRes.status}`);
    }

    await cdp.send('Browser.close').catch(() => null);
    cdp.close();
    if (edgeErr.trim()) console.log('edge stderr tail:', edgeErr.trim().slice(-500));
  } finally {
    if (edge && !edge.killed) {
      try {
        edge.kill();
      } catch {
        /* ignore */
      }
    }
    if (server) await new Promise((r) => server.close(r));
    await srv.stop();
    rmSync(PROFILE, { recursive: true, force: true });
  }

  writeFileSync(
    path.join(OUT, 'shots.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: NODE,
        edge: EDGE,
        note: 'PASS 判定：无横向滚动(scrollWidth<=clientWidth+1)、导航链接可见、截图存在；布局重叠仍需人工 read_image 复核。',
        results,
        extra: extraResults,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\nmanifest: ${path.join(OUT, 'shots.json')}`);

  const failed = results.filter((r) => !r.PASS);
  if (failed.length) {
    console.error(`视觉度量未通过 ${failed.length}/${results.length} 项`);
    process.exitCode = 1;
  } else {
    console.log(`全部 ${results.length} 张截图与布局度量通过`);
  }
}

main().catch((e) => {
  console.error('视觉验收脚本失败:', e);
  process.exitCode = 1;
});
