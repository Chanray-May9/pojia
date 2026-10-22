/**
 * SSG 渲染器：把所有数据渲染成纯静态 HTML。
 * 关键约束：
 * 1) 所有站内链接使用「相对路径」，从而 GitHub Pages 子路径（/repo/）与独立域名通用；
 * 2) HTML 里直接包含正文/回复，搜索引擎不执行 JS 也能读到内容；
 * 3) 构建产物不依赖 node:*，构建时才用 Node。
 */
import { escapeHtml as esc, renderMarkdown, plainText } from '../../shared/markdown.mjs';
import { BRAND } from '../../shared/brand.mjs';
import { CATEGORIES, CATEGORY_MAP, VERIFICATION_LABELS } from '../../shared/categories.mjs';
import { MODELS, MAX_MODELS_PER_THREAD } from '../../shared/models.mjs';

let SETTINGS = {
  siteBase: 'http://127.0.0.1:4401',
  apiBase: 'http://127.0.0.1:4400',
  basePath: '/',
};

export function configure(settings) {
  SETTINGS = { ...SETTINGS, ...settings };
}

export function getSettings() {
  return { ...SETTINGS };
}

export function meta() {
  return { ...SETTINGS };
}

const SHIELD = `<svg class="brand-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
  <path d="M16 2.6 28 6.6v10.1c0 6.6-4.8 10.9-12 12.7C8.8 27.6 4 23.3 4 16.7V6.6Z" fill="none" stroke="currentColor" stroke-width="1.6"/>
  <path d="M16 4.4v23" stroke="currentColor" stroke-width="1.1" opacity=".5"/>
  <path d="M6.2 15.4 25.8 9.4" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"/>
  <circle cx="16" cy="16.4" r="3.1" fill="none" stroke="currentColor" stroke-width="1.4"/>
</svg>`;

const NAV_ITEMS = [
  { path: '', label: '首页', key: 'home' },
  { path: 'category/', label: '板块', key: 'category' },
  { path: 'latest/', label: '最新', key: 'latest' },
  { path: 'search/', label: '搜索', key: 'search' },
];

const depthOf = (pagePath) => {
  const clean = String(pagePath).split('?')[0];
  const dirs = clean.endsWith('.html') ? clean.split('/').slice(0, -1) : clean.split('/');
  return dirs.filter(Boolean).length;
};

export function rel(pagePath, target = '') {
  const depth = depthOf(pagePath);
  const prefix = depth ? '../'.repeat(depth) : './';
  return `${prefix}${String(target).replace(/^\/+/, '')}`;
}

export function abs(pagePath) {
  const clean = pagePath.startsWith('/') ? pagePath : `/${pagePath}`;
  return `${SETTINGS.siteBase}${clean}`;
}

export function formatDate(iso, { dateOnly = false } = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return dateOnly ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(iso) {
  if (!iso) return '暂无动态';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDate(iso, { dateOnly: true });
}

export function excerpt(text, max = 160) {
  return plainText(text, max);
}

function pageShell({
  pagePath,
  title,
  description = BRAND.description,
  robots = 'index,follow,max-image-preview:large',
  ogType = 'website',
  structuredData = null,
  active = '',
  bodyAttrs = '',
  linkMode = 'relative',
  content,
}) {
  const fullTitle = title || `${BRAND.productName} · ${BRAND.tagline}`;
  const canonical = abs(pagePath);
  const ld = structuredData ? JSON.stringify(structuredData).replace(/</g, '\\u003c') : '';
  const baseDir = SETTINGS.basePath || '/';
  const l = (target = '') =>
    linkMode === 'root' ? baseDir + String(target).replace(/^\/+/, '') : rel(pagePath, target);
  const root = linkMode === 'root' ? baseDir : rel(pagePath, '');
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a class="nav-link${active === item.key ? ' is-active' : ''}" href="${l(item.path)}"${
        active === item.key ? ' aria-current="page"' : ''
      }>${item.label}</a>`
  ).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<meta name="keywords" content="${esc(BRAND.keywords.join(','))}">
<meta name="robots" content="${esc(robots)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="theme-color" content="${BRAND.themeColor}">
<meta name="application-name" content="${esc(BRAND.productName)}">
<meta property="og:site_name" content="${esc(BRAND.productName)}">
<meta property="og:locale" content="${BRAND.locale}">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(abs('/assets/og.svg'))}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(fullTitle)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(abs('/assets/og.svg'))}">
<link rel="icon" href="${root}assets/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${esc(BRAND.productName)} · 最新主题" href="${root}feed.xml">
<link rel="stylesheet" href="${root}assets/app.css">
<script src="${root}assets/config.js"></script>
<script src="${root}assets/app.js" defer></script>
${ld ? `<script type="application/ld+json">${ld}</script>` : ''}
</head>
<body ${bodyAttrs}>
<a class="skip-link" href="#main">跳到主要内容</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${l('')}" aria-label="${esc(BRAND.productName)} 首页">
      ${SHIELD}
      <span class="brand-text">
        <strong>${esc(BRAND.productName)}</strong>
        <small>AI 越狱与提示词攻击实战</small>
      </span>
    </a>
    <nav class="primary-nav" aria-label="主导航">${nav}</nav>
    <div class="header-actions">
      <div class="account">
        <span data-guest-only>
          <a class="link-quiet" href="${l('login/')}">登录</a>
          <a class="btn btn-ghost btn-sm" href="${l('register/')}">注册</a>
        </span>
        <span data-auth-only hidden>
          <a class="account-name" data-auth-user href="${l('latest/')}">我的账号</a>
          <a class="nav-link nav-admin" data-admin-only hidden href="${l('admin/')}">管理</a>
          <button type="button" class="link-button" data-logout>退出</button>
        </span>
      </div>
    </div>
  </div>
</header>
<main id="main" class="site-main">
${content}
</main>
<footer class="site-footer">
  <div class="wrap footer-inner">
    <div class="footer-brand">
      <div class="footer-latin">POJIA · ARMOR BREAK LAB</div>
      <p>${esc(BRAND.description)}</p>
    </div>
    <nav class="footer-nav" aria-label="页脚导航">
      <div class="footer-col">
        <h2>站点</h2>
        <ul>
          <li><a href="${l('')}">首页</a></li>
          <li><a href="${l('category/')}">全部板块</a></li>
          <li><a href="${l('latest/')}">最新主题</a></li>
          <li><a href="${l('search/')}">搜索</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h2>关于</h2>
        <ul>
          <li><a href="${l('about/')}">关于本站</a></li>
          <li><a href="${root}feed.xml">RSS 订阅</a></li>
          <li><a href="${root}sitemap.xml">站点地图</a></li>
        </ul>
      </div>
    </nav>
  </div>
  <div class="wrap footer-meta">
    <span>© ${BRAND.siteSince} ${esc(BRAND.productName)}</span>
    <span>POJIA FORUM · STATIC BUILD · API ON CLOUDFLARE</span>
  </div>
</footer>
</body>
</html>`;
}

/* ------------------------------------------------------------ JSON-LD */
// 注意：必须在使用时求值，否则构建脚本 configure() 之前就被冻结成默认域名。
function siteLdNode() {
  return {
    '@type': 'WebSite',
    name: BRAND.productName,
    alternateName: '破甲 AI 安全论坛',
    url: `${SETTINGS.siteBase}/`,
    description: BRAND.description,
    inLanguage: 'zh-CN',
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${SETTINGS.siteBase}/search/?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
    publisher: {
      '@type': 'Organization',
      name: BRAND.productName,
      url: `${SETTINGS.siteBase}/`,
      logo: { '@type': 'ImageObject', url: `${SETTINGS.siteBase}/assets/favicon.svg` },
    },
  };
}

export function ldGraph(extra = []) {
  return { '@context': 'https://schema.org', '@graph': [siteLdNode(), ...extra.filter(Boolean)] };
}

export function breadcrumbLd(items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: abs(item.path),
    })),
  };
}

/* ------------------------------------------------------------ components */
export function breadcrumbs(pagePath, items) {
  return `<nav class="crumbs" aria-label="面包屑">${items
    .map((item, i) => {
      const last = i === items.length - 1;
      const inner = last
        ? `<span class="current" aria-current="page">${esc(item.name)}</span>`
        : `<a href="${rel(pagePath, item.path)}">${esc(item.name)}</a>`;
      return `${i ? '<span class="sep" aria-hidden="true">/</span>' : ''}${inner}`;
    })
    .join('')}</nav>`;
}

export function sectionHead({ eyebrow, title, more, id }) {
  return `<div class="section-head"${id ? ` id="${id}"` : ''}>
    <div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}<h2>${esc(title)}</h2></div>
    ${more ? `<a class="more-link" href="${more.href}">${esc(more.label)} <span aria-hidden="true">→</span></a>` : ''}
  </div>`;
}

function userLink(pagePath, name) {
  if (!name || name === '匿名用户') return esc(name || '匿名用户');
  return `<a href="${rel(pagePath, `u/${encodeURIComponent(name)}/`)}">${esc(name)}</a>`;
}

export function modelChips(thread) {
  const labels = thread.model_labels || [];
  if (!labels.length && !thread.model_custom) return '';
  const chips = labels
    .map((label) => `<span class="tag tag-model" title="目标模型">${esc(label)}</span>`)
    .join('');
  const custom = thread.model_custom
    ? `<span class="tag tag-model tag-custom" title="自定义模型">${esc(thread.model_custom)}</span>`
    : '';
  return `<span class="model-chips">${chips}${custom}</span>`;
}

export function verificationBadge(thread) {
  if (thread.verification === 'admin') {
    return `<span class="verify verify-admin" title="站务已复核该主题的实机验证">实机验证 · 已复核</span>`;
  }
  if (thread.verification === 'self') {
    return `<span class="verify verify-self" title="作者自述已在实机环境验证，未经站务复核">实机验证 · 作者自述</span>`;
  }
  return '';
}

export function threadList(pagePath, threads, { emptyTitle, emptyBody, emptyAction, indexStart = 1 } = {}) {
  if (!threads.length) {
    return `<div class="empty-state">
      <div class="eyebrow">NO RECORDS</div>
      <h2>${esc(emptyTitle || '暂无主题')}</h2>
      <p>${esc(emptyBody || '这里还很安静。成为第一个发帖的人，为板块打底。')}</p>
      ${emptyAction || `<a class="btn btn-signal" href="${rel(pagePath, 'new/')}">发起主题</a>`}
    </div>`;
  }
  return `<ul class="thread-list">${threads
    .map((t, i) => {
      const index = String(indexStart + i).padStart(2, '0');
      const tags = [
        t.pinned ? '<span class="tag tag-pin">置顶</span>' : '',
        t.locked ? '<span class="tag tag-solid">已锁定</span>' : '',
        `<span class="tag">${esc(t.category_name)}</span>`,
        modelChips(t),
        verificationBadge(t),
      ].join('');
      return `<li class="thread-item"><a class="thread-row" href="${rel(pagePath, `${t.path.replace(/^\//, '')}`)}">
        <span class="thread-index">${index}</span>
        <span class="thread-main">
          <span class="thread-tags">${tags}</span>
          <span class="thread-title">${esc(t.title)}</span>
          <span class="thread-meta"><span>发起 <strong>${esc(t.author)}</strong></span><span>${relativeTime(t.last_post_at || t.created_at)}</span></span>
        </span>
        <span class="thread-counts">
          <span class="count-cell"><span class="n">${t.reply_count}</span><span class="k">回复</span></span>
          <span class="count-cell"><span class="n">${t.views}</span><span class="k">浏览</span></span>
        </span>
      </a></li>`;
    })
    .join('')}</ul>`;
}

export function categoryGrid(pagePath, categories) {
  const cards = categories.map(
    (c, i) => `<a class="cat-card" href="${rel(pagePath, `c/${c.slug}/`)}">
      <span class="cat-index">${String(i + 1).padStart(2, '0')} / ${esc(c.latin || 'SECTOR')}</span>
      <span class="cat-name">${esc(c.name)}<span class="latin">${esc(c.latin || '')}</span></span>
      <span class="cat-desc">${esc(c.description)}</span>
      <span class="cat-foot"><span>${c.thread_count} 主题 · ${c.post_count} 回复</span><span class="go">进入 →</span></span>
    </a>`
  );
  // 7 个板块在 12 栅格里会留下空格：用一块"索引"板补位，避免破洞
  const rest = categories.length - 2;
  const rem = rest > 0 ? rest % 3 : 0;
  if (rem) {
    const span = rem === 1 ? 8 : 4;
    cards.push(`<a class="cat-card cat-filler" style="grid-column: span ${span}" href="${rel(pagePath, 'category/')}">
      <span class="cat-index">INDEX / 板块索引</span>
      <span class="cat-name">按方向浏览<span class="latin">SECTORS OVERVIEW</span></span>
      <span class="cat-desc">越狱实战、提示词注入、红队评估、防御对齐、工具资源、模型漏洞与综合讨论——选择你的进攻方向。</span>
      <span class="cat-foot"><span>全部 ${categories.length} 个板块</span><span class="go">查看索引 →</span></span>
    </a>`);
  }
  return `<div class="category-grid">${cards.join('')}</div>`;
}

export function statsCard(stats) {
  return `<section class="side-card" aria-labelledby="stats-title">
    <h2 id="stats-title">论坛数据</h2>
    <div class="side-stats">
      <div><span class="num">${stats.threads}</span><span class="key">主题</span></div>
      <div><span class="num">${stats.posts}</span><span class="key">回复</span></div>
      <div><span class="num">${stats.users}</span><span class="key">成员</span></div>
      <div><span class="num">${stats.last_activity ? relativeTime(stats.last_activity) : '—'}</span><span class="key">最近动态</span></div>
    </div>
  </section>`;
}

export function quickLinks(pagePath, categories) {
  return `<section class="side-card" aria-labelledby="links-title">
    <h2 id="links-title">板块索引</h2>
    <ul class="side-links">
      ${categories
        .map(
          (c) =>
            `<li><a href="${rel(pagePath, `c/${c.slug}/`)}"><span>${esc(c.name)}</span><span class="count">${c.thread_count}</span></a></li>`
        )
        .join('')}
      <li><a href="${rel(pagePath, 'latest/')}"><span>最新主题</span><span class="count">ALL</span></a></li>
      <li><a href="${rel(pagePath, 'feed.xml')}"><span>RSS 订阅</span><span class="count">XML</span></a></li>
    </ul>
  </section>`;
}

export function pagination(pagePath, { page, totalPages, base }) {
  if (totalPages <= 1) return '';
  const url = (n) => `${rel(pagePath, `${base}${n === 1 ? '' : `page/${n}/`}`)}`;
  const items = [];
  const push = (n) =>
    items.push(
      n === page
        ? `<span class="page-num is-current" aria-current="page">${n}</span>`
        : `<a class="page-num" href="${url(n)}">${n}</a>`
    );
  if (page > 2) push(1);
  if (page > 3) items.push('<span class="page-gap">…</span>');
  for (let n = Math.max(1, page - 1); n <= Math.min(totalPages, page + 1); n++) push(n);
  if (page < totalPages - 2) items.push('<span class="page-gap">…</span>');
  if (page < totalPages - 1) push(totalPages);
  return `<nav class="pagination" aria-label="分页">${items.join('')}
    ${page > 1 ? `<a class="page-nav" href="${url(page - 1)}" rel="prev">上一页</a>` : ''}
    ${page < totalPages ? `<a class="page-nav" href="${url(page + 1)}" rel="next">下一页</a>` : ''}
  </nav>`;
}

export function formErrorBox() {
  return `<div class="notice notice-error" data-form-error role="alert" hidden></div>`;
}

/* ---------------------------------------------------------------- pages */

export function sideNav(pagePath, categories, activeSlug = '') {
  return `<nav class="side-nav" aria-label="板块导航">
    <h2>板块</h2>
    <ul>
      ${categories
        .map(
          (c) => `<li><a class="${c.slug === activeSlug ? 'is-active' : ''}" href="${rel(pagePath, `c/${c.slug}/`)}">
            <span>${esc(c.name)}</span><span class="count">${c.thread_count}</span>
          </a></li>`
        )
        .join('')}
    </ul>
    <a class="side-nav-all" href="${rel(pagePath, 'category/')}">全部板块 →</a>
    <a class="side-nav-new" href="${rel(pagePath, 'category/new/')}">＋ 新建板块</a>
    <a class="side-nav-new side-nav-thread" href="${rel(pagePath, 'new/')}">＋ 发起主题</a>
  </nav>`;
}

export function homePage({ page = 1, stats, categories, threads, total, totalPages }) {
  const pagePath = page === 1 ? '/' : `/page/${page}/`;
  const banner =
    page === 1
      ? `<div class="wrap"><section class="home-banner">
    <div class="home-banner-copy">
      <div class="eyebrow">POJIA FORUM / AI破甲</div>
      <h1>${esc(BRAND.productName)}</h1>
      <p class="lede">${esc(BRAND.description)}</p>
      <div class="home-banner-actions">
        <a class="btn btn-signal" href="${rel(pagePath, 'new/')}">＋ 发起主题</a>
        <a class="btn btn-ghost" href="${rel(pagePath, 'category/')}">浏览全部板块</a>
      </div>
    </div>
    <div class="home-banner-side">
      <form class="home-search" action="${rel(pagePath, 'search/')}" method="get" role="search">
        <input type="search" name="q" maxlength="80" placeholder="搜索主题、模型、漏洞…" aria-label="搜索主题">
        <button class="btn btn-signal" type="submit">搜索</button>
      </form>
      <ul class="home-stats">
        <li><strong>${stats.threads}</strong><span>主题</span></li>
        <li><strong>${stats.posts}</strong><span>回复</span></li>
        <li><strong>${stats.users}</strong><span>成员</span></li>
      </ul>
    </div>
  </section></div>`
      : '';

  const content = `${banner}
  <div class="wrap">
    <div class="shell shell-3">
      ${sideNav(pagePath, categories)}
      <div class="shell-main">
        <section class="section section-flush" aria-labelledby="latest-title">
          ${sectionHead({
            eyebrow: 'RECENT THREADS',
            title: page === 1 ? '最新主题' : `最新主题 · 第 ${page} 页`,
            id: 'latest-title',
            more: { href: rel(pagePath, 'latest/'), label: '全部主题' },
          })}
          ${threadList(pagePath, threads, { indexStart: (page - 1) * BRAND.pageSize + 1 })}
        </section>
        ${pagination(pagePath, { page, totalPages, base: '' })}
        <nav class="sector-strip" aria-label="板块速览">
          <span class="sector-strip-label">板块速览</span>
          ${categories
            .map((c) => `<a href="${rel(pagePath, `c/${c.slug}/`)}">${esc(c.name)}<span>${c.thread_count}</span></a>`)
            .join('')}
        </nav>
      </div>
      <aside class="sidebar">
        ${statsCard(stats)}
        
      </aside>
    </div>
  </div>`;

  return pageShell({
    pagePath,
    title: page === 1 ? `${BRAND.productName} · ${BRAND.tagline}` : `最新主题 · 第 ${page} 页 · ${BRAND.productName}`,
    description: BRAND.description,
    canonical: pagePath,
    active: 'home',
    bodyAttrs: 'data-page="home"',
    structuredData: ldGraph([
      {
        '@type': 'CollectionPage',
        name: `${BRAND.productName}最新主题`,
        url: abs(pagePath),
        inLanguage: 'zh-CN',
        isPartOf: { '@type': 'WebSite', url: `${SETTINGS.siteBase}/` },
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: threads.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.title, url: abs(t.path) })),
        },
      },
    ]),
    content,
  });
}

export function categoryIndexPage({ stats, categories }) {
  const pagePath = '/category/';
  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [{ name: '首页', path: '' }, { name: '板块总览', path: 'category/' }])}
    <div class="page-head">
      <div class="eyebrow">SECTORS / 全部板块</div>
      <h1>选择你的进攻方向</h1>
      <p>越狱实战、提示词注入、红队评估、防御对齐、工具资源、模型漏洞与综合讨论。板块可以由任何登录用户自建；发帖前把内容放进对应板块。</p>
    </div>
    <div class="shell">
      <div class="shell-main">
        ${categoryGrid(pagePath, categories)}
        <section class="section">
          ${sectionHead({ eyebrow: 'GUIDELINES', title: '发帖前请先确认', id: 'guide-title' })}
          <div class="prose"><ul>
            <li><strong>打就打完</strong>：给出模型版本、会话结构、提示层级与完整复现步骤。</li>
            <li><strong>标注模型</strong>：发帖时可多选目标模型；实机验证分作者自述与站务复核两级。</li>
            <li><strong>只发真的</strong>：结论要有输入输出证据，区分实测与猜测。</li>
            <li><strong>新板块随便开</strong>：研究方向不够用就新建板块，别把帖子硬塞进不合适的板块。</li>
          </ul></div>
        </section>
      </div>
      <aside class="sidebar">${statsCard(stats)}${quickLinks(pagePath, categories)}</aside>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `板块总览 · ${BRAND.productName}`,
    description: '破甲论坛全部板块：越狱实战、提示词注入、红队评估、防御与对齐、工具与资源、模型漏洞、综合讨论，以及用户自建板块。',
    canonical: pagePath,
    active: 'category',
    bodyAttrs: 'data-page="category-index"',
    structuredData: ldGraph([
      breadcrumbLd([{ name: '首页', path: '' }, { name: '板块总览', path: 'category/' }]),
      {
        '@type': 'CollectionPage',
        name: '板块总览',
        url: abs(pagePath),
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: categories.map((c, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: c.name,
            url: abs(`/c/${c.slug}/`),
          })),
        },
      },
    ]),
    content,
  });
}

export function categoryPage({ category, threads, stats, categories, page = 1, totalPages }) {
  const base = `/c/${category.slug}/`;
  const pagePath = page === 1 ? base : `${base}page/${page}/`;
  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [
      { name: '首页', path: '' },
      { name: '板块总览', path: 'category/' },
      { name: category.name, path: base },
    ])}
    <header class="cat-hero">
      <div>
        <div class="latin">${esc(category.latin)} / ${String(CATEGORY_MAP.get(category.slug)?.order || 1).padStart(2, '0')}</div>
        <h1>${esc(category.name)}${page > 1 ? ` <span class="page-suffix">· 第 ${page} 页</span>` : ''}</h1>
        <p>${esc(category.description)}</p>
      </div>
      <div class="count-pill"><b>${category.thread_count}</b> 主题 / <b>${category.post_count}</b> 回复</div>
    </header>
    <div class="shell shell-3">
      ${sideNav(pagePath, categories, category.slug)}
      <div class="shell-main">
        <div class="section section-flush">
          ${threadList(pagePath, threads, {
            emptyTitle: `${category.name}还没有主题`,
            emptyBody: '这个板块正在等待第一篇研究记录。给出可复现的观察，就是最好的开场。',
            emptyAction: `<a class="btn btn-signal" href="${rel(pagePath, 'new/?category=' + encodeURIComponent(category.slug))}">发起第一篇主题</a>`,
            indexStart: (page - 1) * BRAND.pageSize + 1,
          })}
          ${pagination(pagePath, { page, totalPages, base: `/c/${category.slug}/` })}
        </div>
      </div>
      <aside class="sidebar">
        
        <section class="side-card">
          <h2>板块说明</h2>
          <p>${esc(category.description)}</p>
          <p><a href="${rel(pagePath, `new/?category=${encodeURIComponent(category.slug)}`)}">在此板块发起主题 →</a></p>
        </section>
      </aside>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `${category.name}${page > 1 ? ` · 第 ${page} 页` : ''} · ${BRAND.productName}`,
    description: `${category.name}板块：${category.description}`,
    canonical: pagePath,
    active: 'category',
    bodyAttrs: 'data-page="category"',
    structuredData: ldGraph([
      breadcrumbLd([
        { name: '首页', path: '' },
        { name: '板块总览', path: 'category/' },
        { name: category.name, path: base },
      ]),
      {
        '@type': 'CollectionPage',
        name: `${category.name} · ${BRAND.productName}`,
        url: abs(pagePath),
        description: category.description,
        inLanguage: 'zh-CN',
        isPartOf: { '@type': 'WebSite', url: `${SETTINGS.siteBase}/` },
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: threads.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.title, url: abs(t.path) })),
        },
      },
    ]),
    content,
  });
}

export function latestPage({ threads, totalPages, page = 1, stats, categories }) {
  const pagePath = page === 1 ? '/latest/' : `/latest/page/${page}/`;
  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [{ name: '首页', path: '' }, { name: '最新主题', path: 'latest/' }])}
    <div class="page-head">
      <div class="eyebrow">LATEST / 最新发布</div>
      <h1>最新主题</h1>
      <p>全部板块按最后回复时间排序，最新讨论优先。</p>
    </div>
    <div class="shell">
      <div class="shell-main">
        ${threadList(pagePath, threads, { indexStart: (page - 1) * BRAND.pageSize + 1 })}
        ${pagination(pagePath, { page, totalPages, base: '/latest/' })}
      </div>
      <aside class="sidebar">${quickLinks(pagePath, categories)}</aside>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `最新主题${page > 1 ? ` · 第 ${page} 页` : ''} · ${BRAND.productName}`,
    description: '破甲论坛最新发布与最新回复的 AI 越狱与提示词攻防研究主题。',
    canonical: pagePath,
    active: 'latest',
    bodyAttrs: 'data-page="latest"',
    structuredData: ldGraph([
      breadcrumbLd([{ name: '首页', path: '' }, { name: '最新主题', path: 'latest/' }]),
      {
        '@type': 'CollectionPage',
        name: '最新主题',
        url: abs(pagePath),
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: threads.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.title, url: abs(t.path) })),
        },
      },
    ]),
    content,
  });
}

export function threadPage({ thread, categories }) {
  const pagePath = thread.path;
  const posts = thread.posts || [];
  const metaTags = [
    thread.pinned ? '<span class="tag tag-pin">置顶</span>' : '',
    thread.locked ? '<span class="tag tag-solid">已锁定</span>' : '',
    `<a class="tag" href="${rel(pagePath, `c/${thread.category}/`)}">${esc(thread.category_name)}</a>`,
    modelChips(thread),
    verificationBadge(thread),
  ].join('');

  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [
      { name: '首页', path: '' },
      { name: '板块总览', path: 'category/' },
      { name: thread.category_name, path: `c/${thread.category}/` },
      { name: thread.title.length > 24 ? `${thread.title.slice(0, 24)}…` : thread.title, path: thread.path },
    ])}
    <article class="thread-article">
      <header class="article-head">
        <div class="thread-tags">${metaTags}</div>
        <h1>${esc(thread.title)}</h1>
        <div class="article-meta">
          <span>作者 <span class="author">${userLink(pagePath, thread.author)}</span></span>
          <span>发布于 <time datetime="${esc(thread.created_at)}">${formatDate(thread.created_at)}</time></span>
          <span>浏览 <strong data-view-count>${thread.views}</strong></span>
          <span>回复 <strong>${thread.reply_count}</strong></span>
        </div>
        ${
          thread.verification !== 'none'
            ? `<div class="verify-note">${verificationBadge(thread)}
                <span class="verify-hint">${
                  thread.verification === 'admin'
                    ? '该主题的实机验证由站务复核确认。'
                    : '实机验证为作者自述，尚未经站务复核；请自行判断复现价值。'
                }</span></div>`
            : ''
        }
      </header>
    </article>
    <section aria-labelledby="posts-title">
      <div class="replies-head">
        <h2 id="posts-title">主题正文与回复</h2>
        <span class="count">${posts.length} 条回复 / 共 ${posts.length + 1} 层</span>
      </div>
      <ol class="post-list">
        <li class="post-item">
          <div class="post-side">
            <div class="post-floor">OP / 01</div>
            <div class="post-author">${userLink(pagePath, thread.author)}</div>
            <div class="post-when"><time datetime="${esc(thread.created_at)}">${formatDate(thread.created_at, { dateOnly: true })}</time></div>
          </div>
          <div class="post-main">
            <div class="article-body">${renderMarkdown(thread.body)}</div>
            <div class="article-toolbar">
              <a class="btn btn-ghost btn-sm" href="#reply">写回复</a>
              <a class="btn btn-ghost btn-sm" href="${rel(pagePath, `search/?q=${encodeURIComponent(thread.title)}`)}">搜索相关主题</a>
              ${thread.locked ? '<span class="tag tag-solid">该主题已锁定，暂停回复</span>' : ''}
            </div>
          </div>
        </li>
        ${posts
          .map(
            (p) => `<li class="post-item" id="p${p.id}">
          <div class="post-side">
            <div class="post-floor">#${String(p.floor).padStart(2, '0')}</div>
            <div class="post-author">${userLink(pagePath, p.author)}</div>
            <div class="post-when"><time datetime="${esc(p.created_at)}">${formatDate(p.created_at)}</time></div>
          </div>
          <div class="post-main">${renderMarkdown(p.body)}
            <p><a class="reply-anchor" href="#p${p.id}">#${p.floor}</a></p>
          </div>
        </li>`
          )
          .join('')}
      </ol>
      <form class="reply-box" id="reply" data-api-form="threads/${thread.id}/replies" data-success="redirect">
        <h2>写回复</h2>
        <p class="hint">支持 Markdown：代码块、引用、列表、链接。不用注册，直接发。</p>
        ${formErrorBox()}
        <p class="hint" data-guest-only>未登录将以「匿名用户」发布；<a href="${rel(pagePath, 'login/')}">登录</a> 后显示你的昵称。</p>
        <div class="field">
          <label for="reply-body">回复内容<span class="required">*</span></label>
          <textarea id="reply-body" name="body" required minlength="4" maxlength="20000" placeholder="补充复现结果、反例、或对结论的质疑…"></textarea>
        </div>
        <div class="form-actions">
          <button class="btn btn-signal" type="submit">发布回复</button>
          <span class="aside" data-guest-only>想留名？<a href="${rel(pagePath, 'register/')}">注册</a> 或 <a href="${rel(pagePath, 'login/')}">登录</a>。</span>
        </div>
      </form>
      <noscript><div class="notice">回复与发帖需要启用 JavaScript（静态站点通过 Cloudflare API 提交）。</div></noscript>
    </section>
    <section class="section">
      ${sectionHead({ eyebrow: 'MORE FROM SECTOR', title: '同板块主题', id: 'more-title', more: { href: rel(pagePath, `c/${thread.category}/`), label: '查看板块' } })}
      ${
        (categories.find((c) => c.slug === thread.category)?.threads || []).length
          ? `<ul class="side-links">${categories
              .find((c) => c.slug === thread.category)
              .threads.slice(0, 6)
              .map((t) => `<li><a href="${rel(pagePath, t.path.replace(/^\//, ''))}"><span>${esc(t.title)}</span><span class="count">${t.reply_count}</span></a></li>`)
              .join('')}</ul>`
          : ''
      }
    </section>
  </div>`;

  return pageShell({
    pagePath,
    title: thread.title,
    description: excerpt(thread.body, 150) || `${thread.title} —— ${BRAND.productName}`,
    canonical: pagePath,
    ogType: 'article',
    bodyAttrs: `data-page="thread" data-thread-id="${thread.id}"`,
    structuredData: ldGraph([
      breadcrumbLd([
        { name: '首页', path: '' },
        { name: thread.category_name, path: `c/${thread.category}/` },
        { name: thread.title, path: thread.path },
      ]),
      {
        '@type': 'DiscussionForumPosting',
        headline: thread.title,
        url: abs(pagePath),
        mainEntityOfPage: { '@type': 'WebPage', '@id': abs(pagePath) },
        datePublished: thread.created_at,
        dateModified: thread.last_post_at,
        inLanguage: 'zh-CN',
        articleBody: excerpt(thread.body, 300),
        author: { '@type': 'Person', name: thread.author, url: abs(`/u/${encodeURIComponent(thread.author)}/`) },
        commentCount: thread.reply_count,
        interactionStatistic: [
          { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: thread.reply_count },
          { '@type': 'InteractionCounter', interactionType: 'https://schema.org/ViewAction', userInteractionCount: thread.views },
        ],
        isPartOf: { '@type': 'WebSite', url: `${SETTINGS.siteBase}/` },
        publisher: { '@type': 'Organization', name: BRAND.productName, url: `${SETTINGS.siteBase}/` },
        additionalProperty: [
          { '@type': 'PropertyValue', name: '目标模型', value: (thread.model_labels || []).join('、') || '未标注' },
          { '@type': 'PropertyValue', name: '实机验证', value: thread.verification },
        ],
        ...(posts.length
          ? {
              comment: posts.slice(0, 10).map((p) => ({
                '@type': 'Comment',
                text: excerpt(p.body, 200),
                dateCreated: p.created_at,
                author: { '@type': 'Person', name: p.author },
              })),
            }
          : {}),
      },
    ]),
    content,
  });
}

export function userPage({ user, threads, categories }) {
  const pagePath = `/u/${encodeURIComponent(user.username)}/`;
  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [{ name: '首页', path: '' }, { name: user.username, path: pagePath }])}
    <header class="profile-head">
      <div class="avatar" aria-hidden="true">${esc(user.username.slice(0, 1).toUpperCase())}</div>
      <div>
        <div class="eyebrow">MEMBER PROFILE</div>
        <h1>${esc(user.username)}</h1>
        <div class="profile-meta">
          <span>加入于 ${esc(String(user.created_at).slice(0, 10))}</span>
          <span>${user.thread_count} 主题</span>
          <span>${user.post_count} 帖子</span>
          ${user.role === 'admin' ? '<span class="tag tag-pin">站务</span>' : ''}
        </div>
      </div>
    </header>
    <div class="shell">
      <div class="shell-main">
        <div class="section" style="margin-top:26px">
          ${sectionHead({ eyebrow: 'THREADS', title: '发起的主题', id: 'user-threads' })}
          ${
            threads.length
              ? `<ul class="thread-list">${threads
                  .map(
                    (t, i) => `<li class="thread-item"><a class="thread-row" href="${rel(pagePath, t.path.replace(/^\//, ''))}">
                      <span class="thread-index">${String(i + 1).padStart(2, '0')}</span>
                      <span class="thread-main">
                        <span class="thread-tags"><span class="tag">${esc(t.category_name)}</span>${modelChips(t)}${verificationBadge(t)}</span>
                        <span class="thread-title">${esc(t.title)}</span>
                        <span class="thread-meta"><span>${t.reply_count} 回复</span></span>
                      </span>
                      <span class="thread-counts"></span>
                    </a></li>`
                  )
                  .join('')}</ul>`
              : `<div class="empty-state"><h2>还没有发起主题</h2><p>该成员尚未发布研究主题。</p></div>`
          }
        </div>
      </div>
      <aside class="sidebar">${quickLinks(pagePath, categories)}</aside>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `${user.username} 的主页 · ${BRAND.productName}`,
    description: `${user.username} 在破甲论坛发起的 AI 越狱与提示词攻防研究主题。`,
    canonical: pagePath,
    bodyAttrs: 'data-page="user"',
    structuredData: ldGraph([
      breadcrumbLd([{ name: '首页', path: '' }, { name: user.username, path: pagePath }]),
      { '@type': 'ProfilePage', name: `${user.username} 的主页`, url: abs(pagePath), inLanguage: 'zh-CN' },
    ]),
    content,
  });
}

export function aboutPage() {
  const pagePath = '/about/';
  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [{ name: '首页', path: '' }, { name: '关于本站', path: pagePath }])}
    <div class="page-head">
      <div class="eyebrow">ABOUT POJIA</div>
      <h1>关于本站</h1>
      <p>破甲（POJIA）取意"破甲弹"：以最小代价击穿防护。这里站的是进攻方视角。</p>
    </div>
    <div class="shell">
      <div class="shell-main"><div class="prose">
        <p><strong>破甲论坛</strong>是一个攻击方视角的 AI 越狱与提示词攻防实战社区。</p>
        <h2>在这里做什么</h2>
        <ul>
          <li>发<strong>真打实测</strong>的记录：提示结构、模型版本、观察结果、复现步骤。</li>
          <li>拆注入链路：直接注入、间接注入、工具投毒、Agent 上下文劫持。</li>
          <li>交换红队打法与工具，把"能绕"沉淀成可交付的结论。</li>
          <li>自己开板块：研究方向上没有合适的入口，就新建一个。</li>
        </ul>
        <h2>技术架构</h2>
        <p>前端构建期静态生成（SSG），同一份产物同时部署在 Cloudflare Pages 与 GitHub Pages；后端是 Cloudflare Worker + D1。静态直出的 HTML 让搜索引擎和禁用 JS 的读者都能读到完整内容。</p>
        <h2>联系</h2>
        <p>站务与合作：<code>${esc(BRAND.contactEmail)}</code>。</p>
      </div></div>
      <aside class="sidebar">
        <section class="side-card"><h2>链接</h2><ul class="side-links">
          <li><a href="${rel(pagePath, 'category/new/')}"><span>新建板块</span><span class="count">NEW</span></a></li>
          <li><a href="${rel(pagePath, 'feed.xml')}"><span>RSS 订阅</span><span class="count">XML</span></a></li>
        </ul></section>
      </aside>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `关于本站 · ${BRAND.productName}`,
    description: '关于破甲论坛：攻击方视角的 AI 越狱与提示词攻防实战社区、技术架构与联系方式。',
    canonical: pagePath,
    bodyAttrs: 'data-page="about"',
    structuredData: ldGraph([
      breadcrumbLd([{ name: '首页', path: '' }, { name: '关于本站', path: pagePath }]),
      { '@type': 'WebPage', name: '关于本站', url: abs(pagePath), inLanguage: 'zh-CN' },
    ]),
    content,
  });
}

export function searchPage() {
  const pagePath = '/search/';
  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [{ name: '首页', path: '' }, { name: '搜索', path: pagePath }])}
    <div class="page-head">
      <div class="eyebrow">SEARCH / 站内检索</div>
      <h1>搜索主题与记录</h1>
      <p>按标题、正文与回复全文匹配。搜索结果页不参与索引，请直接引用具体主题链接。</p>
    </div>
    <div class="shell">
      <div class="shell-main">
        <form class="search-form" data-search-form role="search">
          <input type="search" name="q" placeholder="输入关键词，例如：上下文挤压、system prompt、CoT 泄露" aria-label="搜索关键词" maxlength="80">
          <button class="btn" type="submit">搜索</button>
        </form>
        <div class="search-meta" data-search-meta>输入关键词开始检索。</div>
        <div data-search-results></div>
        <noscript><div class="notice">搜索依赖 JavaScript（静态站点通过 Cloudflare API 查询）。你也可以浏览 <a href="${rel(pagePath, 'latest/')}">最新主题</a> 与 <a href="${rel(pagePath, 'category/')}">全部板块</a>。</div></noscript>
      </div>
      <aside class="sidebar">
        <section class="side-card"><h2>搜索建议</h2>
          <ul class="side-links">
            <li><a href="?q=%E8%B6%8A%E7%8B%B1"><span>越狱</span><span class="count">Q</span></a></li>
            <li><a href="?q=%E6%8F%90%E7%A4%BA%E8%AF%8D%E6%B3%A8%E5%85%A5"><span>提示词注入</span><span class="count">Q</span></a></li>
            <li><a href="?q=system%20prompt"><span>system prompt</span><span class="count">Q</span></a></li>
            <li><a href="?q=%E9%98%B2%E5%BE%A1"><span>防御</span><span class="count">Q</span></a></li>
          </ul>
        </section>
        
      </aside>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `搜索 · ${BRAND.productName}`,
    description: '检索破甲论坛中的 AI 越狱、提示词注入与模型安全研究主题。',
    canonical: pagePath,
    robots: 'noindex,follow',
    active: 'search',
    bodyAttrs: 'data-page="search"',
    content,
  });
}

export function newThreadPage({ categories }) {
  const pagePath = '/new/';
  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [{ name: '首页', path: '' }, { name: '发起主题', path: pagePath }])}
    <div class="form-page">
      <div class="page-head">
        <div class="eyebrow">NEW THREAD / 记录研究</div>
        <h1>发起主题</h1>
        <p>发布即公开。请附可复现信息，并如实标注目标模型与实机验证状态。</p>
      </div>
      <div class="form-card">
        ${formErrorBox()}
        <p class="hint" data-guest-only>不用注册也能发：未登录将以「匿名用户」发布，<a href="${rel(pagePath, 'login/')}">登录</a> 后显示你的昵称。</p>
        <form data-api-form="threads" data-success="redirect">
          <div class="field">
            <label for="category">选择板块<span class="required">*</span></label>
            <select id="category" name="category" required>
              ${CATEGORIES.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)} · ${esc(c.latin)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="title">主题标题<span class="required">*</span></label>
            <input id="title" name="title" type="text" required minlength="6" maxlength="120" placeholder="例如：多轮上下文挤压对某类系统提示的绕过观察">
            <p class="hint">6-120 个字符，写清研究对象与结论，便于检索。</p>
          </div>
          <fieldset class="field model-field">
            <legend>目标模型 <span class="hint">（可多选，最多 ${MAX_MODELS_PER_THREAD} 个）</span></legend>
            <div class="model-options">
              ${MODELS.map(
                (m) =>
                  `<label class="model-option"><input type="checkbox" name="models" value="${esc(m.id)}"><span>${esc(m.label)}</span></label>`
              ).join('')}
            </div>
            <div class="field sub-field">
              <label for="model_custom">自定义模型名称（选择"其他"时填写）</label>
              <input id="model_custom" name="model_custom" type="text" maxlength="80" placeholder="例如：某企业内部微调模型 v2">
            </div>
          </fieldset>
          <fieldset class="field verify-field">
            <legend>实机验证</legend>
            <label class="radio-option"><input type="radio" name="verification" value="none" checked> <span>未标注 — 仅理论分析或尚未实机测试</span></label>
            <label class="radio-option"><input type="radio" name="verification" value="self"> <span>实机验证 · 作者自述 — 我已在真实模型上复现（站务可能抽检）</span></label>
            <p class="hint">"站务复核"只能由站务在帖子发布后标记，普通用户无法选择。</p>
          </fieldset>
          <div class="field">
            <label for="body">正文<span class="required">*</span></label>
            <textarea id="body" name="body" required minlength="10" maxlength="30000" placeholder="支持 Markdown。建议结构：&#10;- 测试对象与版本&#10;- 目标模型与接入方式&#10;- 复现步骤&#10;- 观察结果&#10;- 防御建议 / 待验证问题"></textarea>
          </div>
          <div class="form-actions">
            <button class="btn btn-signal" type="submit">发布主题</button>
            <a class="btn btn-ghost" href="${rel(pagePath, 'category/')}">选择板块</a>
          </div>
        </form>
        <noscript><div class="notice">发帖需要启用 JavaScript（静态站点通过 Cloudflare API 提交）。</div></noscript>
      </div>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `发起主题 · ${BRAND.productName}`,
    description: '在破甲论坛发起新的 AI 越狱与提示词攻防研究主题，标注目标模型与实机验证状态。',
    canonical: pagePath,
    robots: 'noindex,nofollow',
    bodyAttrs: 'data-page="new"',
    content,
  });
}

export function authPage({ mode }) {
  const isLogin = mode === 'login';
  const pagePath = isLogin ? '/login/' : '/register/';
  const title = isLogin ? '登录' : '注册';
  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [{ name: '首页', path: '' }, { name: title, path: pagePath }])}
    <div class="form-page">
      <div class="page-head">
        <div class="eyebrow">${isLogin ? 'SIGN IN / 进入研究区' : 'JOIN / 加入研究社区'}</div>
        <h1>${title}</h1>
        <p>${isLogin ? '登录后可发帖、回帖、新建板块与标注实机验证。' : '注册后即可发帖、回帖、新建板块与标注实机验证。'}</p>
      </div>
      <div class="form-card">
        ${formErrorBox()}
        ${
          isLogin
            ? `<form data-api-form="auth/login" data-success="redirect">
          <div class="field"><label for="login">用户名或邮箱<span class="required">*</span></label>
            <input id="login" name="login" type="text" autocomplete="username" required></div>
          <div class="field"><label for="password">密码<span class="required">*</span></label>
            <input id="password" name="password" type="password" autocomplete="current-password" required></div>
          <div class="form-actions">
            <button class="btn" type="submit">登录</button>
            <span class="aside">还没有账号？<a href="${rel(pagePath, 'register/')}">注册</a></span>
          </div>
        </form>`
            : `<form data-api-form="auth/register" data-success="redirect">
          <div class="field"><label for="username">用户名<span class="required">*</span></label>
            <input id="username" name="username" type="text" autocomplete="username" required minlength="3" maxlength="20">
            <p class="hint">3-20 个字符，可用中文、字母、数字、下划线或短横线。</p></div>
          <div class="field"><label for="email">邮箱<span class="required">*</span></label>
            <input id="email" name="email" type="email" autocomplete="email" required maxlength="200">
            <p class="hint">仅用于账号识别与找回，不在公开页面展示。</p></div>
          <div class="field"><label for="password">密码<span class="required">*</span></label>
            <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="200">
            <p class="hint">至少 8 个字符，建议使用密码管理器生成的随机密码。</p></div>
          <div class="form-actions">
            <button class="btn btn-signal" type="submit">创建账号</button>
            <span class="aside">已有账号？<a href="${rel(pagePath, 'login/')}">登录</a></span>
          </div>
        </form>`
        }
        <noscript><div class="notice">登录/注册需要启用 JavaScript（认证请求发送到 Cloudflare API）。</div></noscript>
      </div>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `${title} · ${BRAND.productName}`,
    description: isLogin ? '登录破甲论坛，参与 AI 越狱与提示词攻防实战讨论。' : '注册破甲论坛账号，发布和回复 AI 越狱与提示词攻防实战主题。',
    canonical: pagePath,
    robots: 'noindex,nofollow',
    bodyAttrs: `data-page="${mode}"`,
    content,
  });
}

export function newCategoryPage() {
  const pagePath = '/category/new/';
  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [
      { name: '首页', path: '' },
      { name: '板块总览', path: 'category/' },
      { name: '新建板块', path: pagePath },
    ])}
    <div class="form-page">
      <div class="page-head">
        <div class="eyebrow">NEW SECTOR / 自建板块</div>
        <h1>新建板块</h1>
        <p>现有板块不够用就自己开一个。任何人登录后都可以建，建完会出现在左侧板块导航里（静态站下一次构建后展示）。</p>
      </div>
      <div class="form-card">
        ${formErrorBox()}
        <p class="hint" data-guest-only>你尚未登录：提交时会先跳转到登录页，登录后自动返回。</p>
        <form data-api-form="categories" data-auth-required data-success="redirect">
          <div class="field">
            <label for="name">板块名称<span class="required">*</span></label>
            <input id="name" name="name" type="text" required minlength="2" maxlength="20" placeholder="例如：多模态越狱、Agent 工具投毒、模型指纹">
            <p class="hint">2-20 个字符，会显示在左侧板块导航与帖子标签里。</p>
          </div>
          <div class="field">
            <label for="description">一句话简介</label>
            <input id="description" name="description" type="text" maxlength="120" placeholder="这个板块收什么内容，一两句话说清">
            <p class="hint">最多 120 个字符，会作为板块页的说明。</p>
          </div>
          <div class="form-actions">
            <button class="btn btn-signal" type="submit">创建板块</button>
            <a class="btn btn-ghost" href="${rel(pagePath, 'category/')}">返回板块总览</a>
          </div>
        </form>
        <noscript><div class="notice">新建板块需要启用 JavaScript（静态站点通过 Cloudflare API 提交）。</div></noscript>
      </div>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `新建板块 · ${BRAND.productName}`,
    description: '在破甲论坛新建一个自建板块，收纳新的研究方向。',
    canonical: pagePath,
    robots: 'noindex,nofollow',
    bodyAttrs: 'data-page="new-category"',
    content,
  });
}

export function adminPage() {
  const pagePath = '/admin/';
  const content = `<div class="wrap">
    ${breadcrumbs(pagePath, [{ name: '首页', path: '' }, { name: '管理后台', path: pagePath }])}
    <div class="page-head">
      <div class="eyebrow">ADMIN / 站务</div>
      <h1>管理后台</h1>
      <p>复核实机验证、锁定主题、处理举报。仅管理员可见。</p>
    </div>
    <div class="admin-panel" data-admin-root>
      <div class="notice" data-admin-notice>正在检查管理员权限…</div>
      <div data-admin-content hidden>
        <div class="admin-toolbar">
          <div class="admin-filters" role="tablist">
            <button class="admin-filter is-active" data-admin-filter="pending">待实机复核</button>
            <button class="admin-filter" data-admin-filter="all">全部主题</button>
            <button class="admin-filter" data-admin-filter="locked">已锁定</button>
            <button class="admin-filter" data-admin-filter="reported">被举报</button>
          </div>
          <span class="admin-count" data-admin-count></span>
        </div>
        <div class="admin-list" data-admin-list></div>
        <h2 class="admin-subhead">举报处理</h2>
        <div class="admin-list" data-admin-reports></div>
      </div>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `管理后台 · ${BRAND.productName}`,
    description: '破甲论坛站务管理后台。',
    canonical: pagePath,
    robots: 'noindex,nofollow',
    bodyAttrs: 'data-page="admin"',
    content,
  });
}

export function notFoundPage() {
  // 404.html 会被任意深度的 URL 兜底命中，相对路径会失效；
  // 因此该页统一使用「站点根路径」链接（构建时已知 basePath）。
  const root = SETTINGS.basePath || '/';
  const l = (target = '') => root + String(target).replace(/^\/+/, '');
  const pagePath = '/404.html';
  const content = `<div class="wrap">
    <div class="form-page">
      <div class="page-head">
        <div class="eyebrow">ERROR 404</div>
        <h1>这层甲没破开 — 404</h1>
        <p>你访问的页面不存在，或该主题尚未被静态构建收录。</p>
      </div>
      <div class="form-card">
        <div id="dynamic-fallback" data-dynamic-fallback hidden></div>
        <p class="hint" data-dynamic-hint>如果这是刚发布的主题，页面会在下一次静态构建后可用。</p>
        <div class="form-actions" style="margin-top:0;border-top:0;padding-top:0">
          <a class="btn" href="${l('')}">回到首页</a>
          <a class="btn btn-ghost" href="${l('category/')}">浏览板块</a>
          <a class="btn btn-ghost" href="${l('search/')}">搜索站内</a>
        </div>
      </div>
    </div>
  </div>`;
  return pageShell({
    pagePath,
    title: `页面不存在 · ${BRAND.productName}`,
    description: '你访问的页面不存在。',
    canonical: '/404.html',
    robots: 'noindex,nofollow',
    bodyAttrs: 'data-page="404"',
    linkMode: 'root',
    content,
  });
}
