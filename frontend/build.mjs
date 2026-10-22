#!/usr/bin/env node
/**
 * 静态站点构建（SSG）。
 *
 * 用法：
 *   node frontend/build.mjs
 *   node frontend/build.mjs --api http://127.0.0.1:4400 --site http://127.0.0.1:4401
 *   API_BASE=https://api.example.com SITE_URL=https://pojia.example.com node frontend/build.mjs
 *   node frontend/build.mjs --data snapshot.json   # 离线构建（用快照 JSON）
 *
 * 产出：frontend/dist/，可直接部署到 GitHub Pages / Cloudflare Pages。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../shared/brand.mjs';
import { CATEGORIES } from '../shared/categories.mjs';
import {
  configure,
  homePage,
  categoryIndexPage,
  categoryPage,
  latestPage,
  threadPage,
  userPage,
  newCategoryPage,
  aboutPage,
  searchPage,
  newThreadPage,
  authPage,
  notFoundPage,
  formatDate,
} from './lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'frontend');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const API_BASE = String(args.api || process.env.API_BASE || 'http://127.0.0.1:4400').replace(/\/+$/, '');
const SITE_URL = String(args.site || process.env.SITE_URL || 'http://127.0.0.1:4401').replace(/\/+$/, '');
const OUT_DIR = path.resolve(ROOT, String(args.out || process.env.OUT_DIR || 'frontend/dist'));
const DATA_FILE = args.data || process.env.DATA_FILE || '';
const PAGE_SIZE = BRAND.pageSize;

// 内容派生构建戳：同一份数据多次构建结果一致（保证双前端逐字节一致）。
function contentStamp(threads, users, fallback) {
  const stamps = [];
  for (const t of threads) {
    stamps.push(t.last_post_at, t.created_at, t.updated_at);
  }
  for (const u of users) stamps.push(u.created_at);
  const valid = stamps
    .filter(Boolean)
    .map((s) => (Number.isNaN(new Date(s).getTime()) ? '' : new Date(s).toISOString()))
    .filter(Boolean)
    .sort();
  return valid.length ? valid[valid.length - 1] : fallback || '2026-01-01T00:00:00.000Z';
}

const siteUrlObj = new URL(SITE_URL);
const BASE_PATH = siteUrlObj.pathname.endsWith('/')
  ? siteUrlObj.pathname
  : `${siteUrlObj.pathname}/`;
const SITE_BASE = `${siteUrlObj.origin}${BASE_PATH === '/' ? '' : BASE_PATH.replace(/\/$/, '')}`;

configure({ siteBase: SITE_BASE, apiBase: API_BASE, basePath: BASE_PATH });

const written = [];
function writeFile(relPath, content) {
  const target = path.join(OUT_DIR, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  written.push(relPath);
}

function copyDir(from, toRel) {
  const items = fs.readdirSync(from, { withFileTypes: true });
  for (const item of items) {
    const src = path.join(from, item.name);
    const rel = path.join(toRel, item.name);
    if (item.isDirectory()) copyDir(src, rel);
    else fs.copyFileSync(src, path.join(OUT_DIR, rel));
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function loadSnapshot() {
  if (DATA_FILE) {
    console.log(`[build] 读取快照 ${DATA_FILE}`);
    return JSON.parse(fs.readFileSync(path.resolve(ROOT, DATA_FILE), 'utf8'));
  }
  console.log(`[build] 从 API 拉取快照 ${API_BASE}/api/v1/site`);
  const first = await fetchJson(`${API_BASE}/api/v1/site?page=1&page_size=200`);
  const threads = [...first.threads];
  const totalPages = first.pagination.total_pages;
  for (let p = 2; p <= totalPages; p++) {
    const next = await fetchJson(`${API_BASE}/api/v1/site?page=${p}&page_size=200`);
    threads.push(...next.threads);
  }
  return {
    generated_at: new Date().toISOString(),
    stats: first.stats,
    categories: first.categories,
    users: first.users || [],
    threads,
    pagination: { page: 1, page_size: PAGE_SIZE, total: first.pagination.total, total_pages: Math.ceil(first.pagination.total / PAGE_SIZE) },
  };
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isoDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function main() {
  const snapshot = await loadSnapshot();
  const threads = snapshot.threads || [];
  const categories = (snapshot.categories?.length ? snapshot.categories : CATEGORIES.map((c, i) => ({
    ...c,
    sort_order: i + 1,
    thread_count: 0,
    post_count: 0,
    last_post_at: null,
  }))).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  const stats = snapshot.stats || { threads: threads.length, posts: 0, users: 0, last_activity: null };
  const users = snapshot.users || [];
  // 内容派生时间戳：同一份数据重复构建结果一致，保证双前端逐字节一致。
  const contentStampIso = contentStamp(threads, users, snapshot.generated_at);
  const categorized = categories.map((c) => ({ ...c, threads: threads.filter((t) => t.category === c.slug) }));
  const pinnedFirst = (list) => [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.last_post_at).localeCompare(String(a.last_post_at)));
  const ordered = pinnedFirst(threads);
  const totalThreadPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const urls = [];

  // 首页 + 分页
  for (let page = 1; page <= totalThreadPages; page++) {
    const slice = ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const html = homePage({ page, stats, categories: categorized, threads: slice, total: ordered.length, totalPages: totalThreadPages });
    if (page === 1) writeFile('index.html', html);
    else writeFile(`page/${page}/index.html`, html);
    urls.push({ loc: page === 1 ? `${SITE_BASE}/` : `${SITE_BASE}/page/${page}/`, lastmod: isoDate(contentStampIso), priority: page === 1 ? '1.0' : '0.6', changefreq: 'daily' });
  }

  // 板块总览
  writeFile('category/index.html', categoryIndexPage({ stats, categories: categorized }));
  urls.push({ loc: `${SITE_BASE}/category/`, lastmod: isoDate(contentStampIso), priority: '0.9', changefreq: 'weekly' });

  // 各板块 + 分页
  for (const cat of categorized) {
    const list = pinnedFirst(cat.threads);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    for (let page = 1; page <= pages; page++) {
      const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      const html = categoryPage({ category: cat, threads: slice, stats, categories: categorized, page, totalPages: pages });
      const rel = page === 1 ? `c/${cat.slug}/index.html` : `c/${cat.slug}/page/${page}/index.html`;
      writeFile(rel, html);
      urls.push({
        loc: page === 1 ? `${SITE_BASE}/c/${cat.slug}/` : `${SITE_BASE}/c/${cat.slug}/page/${page}/`,
        lastmod: isoDate(cat.last_post_at || contentStampIso),
        priority: page === 1 ? '0.8' : '0.5',
        changefreq: 'daily',
      });
    }
  }

  // 最新主题 + 分页
  const latestPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  for (let page = 1; page <= latestPages; page++) {
    const slice = ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const html = latestPage({ threads: slice, totalPages: latestPages, page, stats, categories: categorized });
    writeFile(page === 1 ? 'latest/index.html' : `latest/page/${page}/index.html`, html);
    urls.push({
      loc: page === 1 ? `${SITE_BASE}/latest/` : `${SITE_BASE}/latest/page/${page}/`,
      lastmod: isoDate(contentStampIso),
      priority: page === 1 ? '0.8' : '0.5',
      changefreq: 'daily',
    });
  }

  // 主题详情
  for (const thread of ordered) {
    const html = threadPage({ thread, categories: categorized });
    writeFile(`${thread.path.replace(/^\//, '')}index.html`, html);
    urls.push({
      loc: `${SITE_BASE}${thread.path}`,
      lastmod: isoDate(thread.last_post_at),
      priority: '0.7',
      changefreq: 'weekly',
    });
  }

  // 用户主页
  for (const user of users) {
    const userThreads = pinnedFirst(threads.filter((t) => t.author === user.username));
    writeFile(`u/${encodeURIComponent(user.username)}/index.html`, userPage({ user, threads: userThreads, categories: categorized }));
    urls.push({
      loc: `${SITE_BASE}/u/${encodeURIComponent(user.username)}/`,
      lastmod: isoDate(userThreads[0]?.last_post_at || contentStampIso),
      priority: '0.5',
      changefreq: 'weekly',
    });
  }

  // 固定页
  writeFile('about/index.html', aboutPage());
  urls.push({ loc: `${SITE_BASE}/about/`, lastmod: isoDate(contentStampIso), priority: '0.6', changefreq: 'monthly' });

  // 不索引但存在的页面
  writeFile('search/index.html', searchPage());
  writeFile('new/index.html', newThreadPage({ categories }));
  writeFile('category/new/index.html', newCategoryPage());
  writeFile('login/index.html', authPage({ mode: 'login' }));
  writeFile('register/index.html', authPage({ mode: 'register' }));
  writeFile('404.html', notFoundPage());

  // 站点地图
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${xmlEscape(u.loc)}</loc>
    <lastmod>${xmlEscape(u.lastmod)}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>
`;
  writeFile('sitemap.xml', sitemap);

  // robots.txt：注意标签页/搜索结果不索引
  writeFile(
    'robots.txt',
    `# ${BRAND.productName} · robots.txt
# 公开内容允许抓取；搜索、登录、发帖页不参与索引。

User-agent: *
Allow: /
Disallow: /search/
Disallow: /login/
Disallow: /register/
Disallow: /new/
Disallow: /404.html

User-agent: Baiduspider
Allow: /
Crawl-delay: 1

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

Sitemap: ${SITE_BASE}/sitemap.xml
`
  );

  // RSS
  const feedThreads = ordered.slice(0, 30);
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(`${BRAND.productName} · 最新研究主题`)}</title>
    <link>${xmlEscape(`${SITE_BASE}/`)}</link>
    <description>${xmlEscape(BRAND.description)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date(isoDate(contentStampIso)).toUTCString()}</lastBuildDate>
    <atom:link href="${xmlEscape(`${SITE_BASE}/feed.xml`)}" rel="self" type="application/rss+xml"/>
${feedThreads
  .map(
    (t) => `    <item>
      <title>${xmlEscape(t.title)}</title>
      <link>${xmlEscape(`${SITE_BASE}${t.path}`)}</link>
      <guid isPermaLink="true">${xmlEscape(`${SITE_BASE}${t.path}`)}</guid>
      <pubDate>${new Date(isoDate(t.created_at)).toUTCString()}</pubDate>
      <category>${xmlEscape(t.category_name)}</category>
      <author>${xmlEscape(t.author)}</author>
      <description>${xmlEscape(String(t.body || '').slice(0, 280))}</description>
    </item>`
  )
  .join('\n')}
  </channel>
</rss>
`;
  writeFile('feed.xml', rss);

  // 运行时配置
  writeFile(
    'assets/config.js',
    `window.POJIA_CONFIG = ${JSON.stringify(
      { apiBase: API_BASE, base: BASE_PATH, siteUrl: SITE_BASE, builtAt: contentStampIso, pageSize: PAGE_SIZE },
      null,
      2
    )};\n`
  );

  // 静态资源
  copyDir(path.join(FRONTEND, 'public'), 'assets');

  // GitHub Pages 需要 .nojekyll 才会发布下划线开头的文件/目录
  writeFile('.nojekyll', '');

  const summary = {
    siteUrl: SITE_BASE,
    apiBase: API_BASE,
    threads: threads.length,
    categoryPages: urls.filter((u) => u.loc.includes('/c/')).length,
    files: written.length,
    pages_indexable: urls.length,
  };
  console.log('[build] 完成');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('[build] 失败：', err);
  process.exit(1);
});
