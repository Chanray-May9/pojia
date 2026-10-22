// tests/ssg.test.mjs — B. SSG 静态产物验收（不依赖 JS 的 HTML/SEO/标注/降级/404/索引规则）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  ROOT,
  QA_DIR,
  startApi,
  apiFetch,
  seedForum,
  createThreadApi,
  buildDist,
  walkFiles,
  readText,
  titleOf,
  titlesOf,
  h1s,
  metaContent,
  canonicalOf,
  parseLdJson,
  jsonLdTypes,
  allLinks,
  resolveStaticFile,
  locsOf,
  normalizeUrl,
  textOf,
} from './helpers.mjs';

const API_PORT = 4412;
const SITE = 'http://127.0.0.1:4422';
const DIST = path.join(QA_DIR, 'dist-a');

let srv;
let seed;
let build;
let files = [];
let bootError = null;
let customThreadId = null;
let xssThreadId = null;
let customCategory = null;
let anonThreadId = null;

function relFor(pattern) {
  return files.filter((f) => pattern.test(f.rel));
}

function findThreadFile(id) {
  return files.find((f) => new RegExp(`^t/${id}-[^/]+/index\\.html$`).test(f.rel));
}

function flattenLd(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b && Array.isArray(b['@graph'])) out.push(...b['@graph']);
    else out.push(b);
  }
  return out;
}

before(async () => {
  try {
    srv = await startApi({ port: API_PORT, dbFile: 'ssg-test.db' });
    seed = await seedForum(srv.base);

    // 额外样本：自定义模型文本 + 作者自述实机验证
    const customRes = await createThreadApi(srv.base, seed.token, {
      category: seed.threads[0].category || 'jailbreak',
      title: `自定义模型标注验收 ${seed.stamp}`,
      body: `自定义模型标注正文 ${seed.stamp}，marker-${seed.stamp}-custom。`,
      models: ['gpt'],
      model_custom: '内部自研微调模型-v7',
      verification: 'self',
    });
    customThreadId = customRes.json.thread.id;

    // XSS 样本
    const xssRes = await createThreadApi(srv.base, seed.token, {
      category: seed.threads[0].category || 'jailbreak',
      title: `XSS 转义验收 ${seed.stamp}`,
      body: `正文开始 <script>alert(1)</script> <img src=x onerror=alert(2)> 正文结束 marker-${seed.stamp}-xss。`,
      verification: 'none',
    });
    xssThreadId = xssRes.json.thread.id;

    // 匿名发布样本（不登录发帖，作者显示匿名用户）
    const anonRes = await apiFetch(srv.base, 'POST', '/threads', {
      body: {
        category: 'general',
        title: `匿名主题验收 ${seed.stamp}`,
        body: `匿名用户发布的正文 ${seed.stamp}，marker-anon。`,
        verification: 'none',
      },
    });
    if (anonRes.status !== 201) {
      throw new Error(`匿名发帖 -> ${anonRes.status} ${anonRes.text.slice(0, 300)}`);
    }
    anonThreadId = anonRes.json.thread.id;

    // 自建板块样本（构建前创建，验证会进入 SSG 产物）
    const catRes = await apiFetch(srv.base, 'POST', '/categories', {
      token: seed.token,
      body: {
        name: `前端自建板块${seed.stamp}`.slice(0, 20),
        description: `SSG 自建板块验收 ${seed.stamp}`,
      },
    });
    if (catRes.status !== 201) {
      throw new Error(`POST /categories -> ${catRes.status} ${catRes.text.slice(0, 300)}`);
    }
    customCategory = catRes.json.category;

    build = await buildDist({ apiBase: srv.base, siteUrl: SITE, outDir: DIST });
    files = walkFiles(DIST);
  } catch (e) {
    bootError = e;
  }
});

after(async () => {
  if (srv) await srv.stop();
});

function requireBoot() {
  assert.equal(bootError, null, `SSG 构建失败: ${bootError && bootError.stack}`);
}

test('产物结构：关键页面与索引文件齐全', async () => {
  requireBoot();
  const rels = new Set(files.map((f) => f.rel));
  const required = [
    'index.html',
    '404.html',
    'robots.txt',
    'sitemap.xml',
    'feed.xml',
    'category/index.html',
    'latest/index.html',
    'search/index.html',
    'new/index.html',
    'login/index.html',
    'register/index.html',
    'category/new/index.html',
    'about/index.html',
    `u/${seed.user.username}/index.html`,
  ];
  for (const rel of required) {
    assert.ok(rels.has(rel), `缺少静态产物 ${rel}（现有 ${files.length} 个文件）`);
  }
  assert.ok(!rels.has('rules/index.html'), '板块规则页 /rules/ 应已删除，不应再生成 rules/index.html');
  for (const t of seed.threads) {
    assert.ok(findThreadFile(t.id), `缺少主题详情页 t/${t.id}-*/index.html`);
  }
  const catSlug = seed.threads[0].category;
  assert.ok(rels.has(`c/${catSlug}/index.html`), `缺少分类页 c/${catSlug}/index.html`);
  assert.ok(rels.has(`c/${customCategory.slug}/index.html`), `自建板块应有静态页 c/${customCategory.slug}/index.html`);
});

test('首页：SSR 正文 + 唯一 title/desc/canonical/OG/单 h1/WebSite JSON-LD', async () => {
  requireBoot();
  const rel = 'index.html';
  const html = readText(path.join(DIST, rel));
  const text = textOf(html); // 不执行 JS 的纯文本

  assert.ok(text.includes(seed.threads[0].title), '首页 SSR 文本应包含主题标题');
  assert.equal(titlesOf(html).length, 1, '首页应恰好 1 个 <title>');
  assert.ok(titleOf(html).length >= 6, '首页 title 过短');
  const desc = metaContent(html, 'description');
  assert.ok(desc && desc.length >= 10, '首页缺 meta description');
  assert.equal(normalizeUrl(canonicalOf(html)), normalizeUrl(`${SITE}/`), '首页 canonical 应自引用');

  for (const k of ['og:title', 'og:description', 'og:url', 'og:type']) {
    assert.ok(metaContent(html, k), `首页缺 ${k}`);
  }
  assert.match(metaContent(html, 'twitter:card') || '', /summary/i, '首页缺 twitter:card');

  const hs = h1s(html);
  assert.equal(hs.length, 1, `首页应恰好 1 个 h1，实际 ${hs.length}`);

  const ld = parseLdJson(html);
  assert.deepEqual(ld.errors, [], `首页 JSON-LD 解析失败: ${JSON.stringify(ld.errors)}`);
  assert.ok(jsonLdTypes(ld.blocks).has('WebSite'), `首页 JSON-LD 应含 WebSite，实际 ${[...jsonLdTypes(ld.blocks)].join(',')}`);

  // JSON-LD 内所有绝对 URL（除 schema.org 词汇表）必须使用构建配置的 SITE_URL
  const urls = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    for (const v of Object.values(n)) {
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) urls.push(v);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  ld.blocks.forEach(walk);
  const foreign = urls.filter((u) => !u.startsWith(SITE) && !u.startsWith('https://schema.org'));
  assert.deepEqual(
    foreign.slice(0, 8),
    [],
    `JSON-LD 出现非本站绝对 URL（应全部使用 SITE_URL=${SITE}）: ${JSON.stringify(foreign.slice(0, 8))}`,
  );
});

test('主题详情：正文/回复 SSR、canonical 自引用、DiscussionForumPosting + 实机验证结构化属性', async () => {
  requireBoot();
  const file = findThreadFile(seed.threads[0].id);
  assert.ok(file, '缺少主题详情页');
  const html = readText(file.abs);
  const text = textOf(html);

  assert.ok(text.includes(seed.threads[0].title), '详情页应含标题');
  assert.ok(text.includes(seed.markers.alpha), '详情页正文（不依赖 JS）应含正文 marker');
  assert.ok(text.includes(seed.markers.reply), '详情页应含回帖 marker');

  const expectedUrl = `${SITE}/${file.rel.replace(/\/index\.html$/, '/')}`;
  assert.equal(normalizeUrl(canonicalOf(html)), normalizeUrl(expectedUrl), '详情页 canonical 应自引用');
  assert.equal(h1s(html).length, 1, '详情页应恰好 1 个 h1');

  const ld = parseLdJson(html);
  assert.deepEqual(ld.errors, [], `详情页 JSON-LD 解析失败: ${JSON.stringify(ld.errors)}`);
  const types = jsonLdTypes(ld.blocks);
  assert.ok(types.has('DiscussionForumPosting'), `详情页 JSON-LD 应含 DiscussionForumPosting，实际 ${[...types].join(',')}`);

  const posting = flattenLd(ld.blocks).find((b) => b && b['@type'] === 'DiscussionForumPosting');
  assert.ok(posting, '应能找到 DiscussionForumPosting 块（@graph 内）');
  const props = posting.additionalProperty || [];
  assert.ok(
    props.some((p) => /实机验证/.test(p.name || '') && p.value === 'self'),
    `JSON-LD additionalProperty 应含 {name:"实机验证",value:"self"}，实际 ${JSON.stringify(props)}`,
  );
});

test('模型标签与实机验证文案：列表/详情出现，未标注时正常降级', async () => {
  requireBoot();
  const home = readText(path.join(DIST, 'index.html'));
  const detail = readText(findThreadFile(seed.threads[0].id).abs);

  // 模型标签：从 shared/models.mjs 取真实 label（若可导入），否则退化为检查 id/常见写法
  let labels = [];
  try {
    const mod = await import(new URL(`file://${path.join(ROOT, 'shared', 'models.mjs').replace(/\\/g, '/')}`));
    const list = mod.MODELS || mod.models || mod.default || [];
    for (const id of ['gpt', 'claude']) {
      const item = Array.isArray(list) ? list.find((m) => m.id === id) : null;
      if (item?.label) labels.push(item.label);
    }
  } catch {
    /* fallback below */
  }
  if (labels.length === 0) labels = ['GPT', 'Claude'];
  const visible = textOf(home) + textOf(detail);
  for (const label of labels) {
    assert.ok(visible.toLowerCase().includes(label.toLowerCase()), `页面应出现模型标签 ${label}`);
  }

  assert.match(detail, /实机验证\s*·\s*作者自述/, '详情页应出现「实机验证 · 作者自述」文案');
  assert.match(detail, /实机验证/, '详情页应出现实机验证徽标');

  // 未标注样本（threads[2] 无 models、verification=none）→ 不显示模型标签与实机验证徽标
  const noneFile = findThreadFile(seed.threads[2].id);
  assert.ok(noneFile, '缺少未标注样本详情页');
  const noneHtml = readText(noneFile.abs);
  const noneText = textOf(noneHtml);
  assert.ok(noneText.includes(seed.markers.gamma), '降级样本正文应正常渲染');
  assert.ok(!/实机验证/.test(noneText), '未标注的帖子不应显示实机验证文案（防止误标）');
});

test('自定义模型补充文本在详情页可见，且不破坏标签渲染', async () => {
  requireBoot();
  const custom = findThreadFile(customThreadId);
  assert.ok(custom, '缺少自定义模型样本详情页');
  const text = textOf(readText(custom.abs));
  assert.ok(text.includes('内部自研微调模型-v7'), '详情页应显示 model_custom 自定义模型文本');
});

test('唯一 title：首页/分类/详情/搜索标题互不重复', async () => {
  requireBoot();
  const pages = [
    'index.html',
    `c/${seed.threads[0].category}/index.html`,
    findThreadFile(seed.threads[0].id).rel,
    'search/index.html',
  ];
  const seen = new Map();
  for (const rel of pages) {
    const t = titleOf(readText(path.join(DIST, rel)));
    assert.ok(t, `${rel} 缺少 <title>`);
    assert.ok(!seen.has(t), `${rel} 标题与 ${seen.get(t)} 重复: ${t}`);
    seen.set(t, rel);
  }
});

test('noindex 规则：search(noindex,follow)、new/login/register/category-new/404 均 noindex', async () => {
  requireBoot();
  const expect = [
    { rel: 'search/index.html', follow: true },
    { rel: 'new/index.html', follow: false },
    { rel: 'category/new/index.html', follow: false },
    { rel: 'login/index.html', follow: false },
    { rel: 'register/index.html', follow: false },
    { rel: '404.html', follow: false },
  ];
  for (const { rel, follow } of expect) {
    const html = readText(path.join(DIST, rel));
    const robots = (metaContent(html, 'robots') || '').toLowerCase().replace(/\s+/g, '');
    assert.match(robots, /noindex/, `${rel} 应带 noindex，实际 robots=${JSON.stringify(robots)}`);
    if (follow) assert.match(robots, /follow/, `${rel} 应带 follow，实际 robots=${JSON.stringify(robots)}`);
  }
});

test('sitemap.xml：合法 XML、绝对本站 URL、仅公开可索引页、含新主题', async () => {
  requireBoot();
  const xml = readText(path.join(DIST, 'sitemap.xml')).trim();
  assert.match(xml, /^<\?xml\s+version=["']1\.0["']/i, 'sitemap 应以 XML 声明开头');
  assert.match(xml, /<urlset\b[^>]*sitemaps\.org\/schemas\/sitemap\/0\.9/i, 'sitemap 应含标准命名空间');
  assert.match(xml, /<\/urlset>\s*$/i, 'sitemap 应正确闭合');

  const locs = locsOf(xml);
  assert.ok(locs.length >= 5, `sitemap 条目过少: ${locs.length}`);
  for (const loc of locs) {
    assert.match(loc, new RegExp(`^${SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), `sitemap 应只含本站绝对 URL: ${loc}`);
    const p = new URL(loc).pathname;
    assert.ok(!/\/(new|login|register|search|404)(\/|$)/.test(p), `sitemap 不应包含 noindex 页面: ${loc}`);
    assert.ok(!/\/rules(\/|$)/.test(p), `sitemap 不应再包含已删除的 /rules/ 页面: ${loc}`);
    assert.ok(!/\/category\/new(\/|$)/.test(p), `sitemap 不应包含 noindex 的新建板块页: ${loc}`);
  }
  const threadFile = findThreadFile(seed.threads[0].id);
  const expected = `${SITE}/${threadFile.rel.replace(/\/index\.html$/, '/')}`;
  assert.ok(
    locs.some((l) => normalizeUrl(l) === normalizeUrl(expected)),
    `sitemap 应包含新主题 ${expected}`,
  );
  assert.ok(locs.some((l) => normalizeUrl(l) === normalizeUrl(`${SITE}/c/${seed.threads[0].category}/`)), 'sitemap 应包含分类页');
  assert.ok(
    locs.some((l) => normalizeUrl(l) === normalizeUrl(`${SITE}/c/${customCategory.slug}/`)),
    `sitemap 应包含自建板块 /c/${customCategory.slug}/`,
  );
});

test('robots.txt 与 feed.xml 正确', async () => {
  requireBoot();
  const robots = readText(path.join(DIST, 'robots.txt'));
  assert.match(robots, /User-agent:\s*\*/i, 'robots 应有 User-agent: *');
  assert.match(robots, new RegExp(`Sitemap:\\s*${SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sitemap\\.xml`, 'i'), 'robots 应声明本站 sitemap');
  for (const bad of ['/new', '/login', '/search']) {
    assert.match(robots, new RegExp(`Disallow:\\s*${bad}`, 'i'), `robots 应 Disallow ${bad}`);
  }

  const feed = readText(path.join(DIST, 'feed.xml')).trim();
  assert.match(feed, /^<\?xml\s+version=["']1\.0["']/i, 'feed 应为 XML');
  assert.match(feed, /<rss\b|<feed\b/i, 'feed 应为 RSS/Atom');
  assert.ok(feed.includes(seed.threads[0].title) || feed.includes(seed.stamp), 'feed 应包含最新主题');
});

test('不依赖 JS：禁用脚本也能从 HTML 读取正文（script 标签不影响 SSR 文本）', async () => {
  requireBoot();
  const html = readText(findThreadFile(seed.threads[0].id).abs);
  const withoutScripts = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const text = textOf(withoutScripts);
  assert.ok(text.includes(seed.markers.alpha), '移除 <script> 后正文应仍可读');
  assert.ok(text.includes(seed.markers.reply), '移除 <script> 后回帖应仍可读');
});

test('内部链接全部相对路径，且相对路径在 dist 内可解析', async () => {
  requireBoot();
  const pages = [
    'index.html',
    `c/${seed.threads[0].category}/index.html`,
    findThreadFile(seed.threads[0].id).rel,
    'search/index.html',
  ];
  for (const rel of pages) {
    const html = readText(path.join(DIST, rel));
    for (const link of allLinks(html, `${SITE}/${rel}`)) {
      const href = link.href;
      if (/^https?:/i.test(href) || href.startsWith('//')) continue;
      assert.ok(!href.startsWith('/'), `${rel} 内部链接不应以 / 开头（子路径不兼容）: ${href}`);
      assert.ok(!href.includes('127.0.0.1:4422'), `${rel} 内部链接不应硬编码站点域名: ${href}`);
      const target = resolveStaticFile(DIST, rel, href);
      assert.ok(target, `${rel} 中的相对链接无法在 dist 内解析: ${href}`);
    }
  }
});

test('XSS：内容中的 <script>/onerror 在静态产物中已转义', async () => {
  requireBoot();
  const xssFile = findThreadFile(xssThreadId);
  assert.ok(xssFile, '缺少 XSS 样本详情页');

  const html = readText(xssFile.abs);
  const dangers = [
    { name: '内联 script', re: /<script[^>]*>\s*alert\s*\(/i },
    { name: 'img onerror', re: /<img[^>]+onerror\s*=/i },
    { name: 'svg onload', re: /<svg[^>]+onload\s*=/i },
    { name: 'script 断链', re: /<\/script\s*>\s*<script[^>]*>\s*alert/i },
  ];
  for (const d of dangers) assert.ok(!d.re.test(html), `静态产物出现未转义 XSS（${d.name}）`);
  assert.match(html, /&lt;script/i, '应出现转义后的 &lt;script');

  const ld = parseLdJson(html);
  assert.deepEqual(ld.errors, [], `XSS 导致 JSON-LD 破损: ${JSON.stringify(ld.errors)}`);
});

test('assets/config.js 注入构建参数：apiBase 指向构建 API、siteUrl 指向 SITE_URL', async () => {
  requireBoot();
  const cfgPath = path.join(DIST, 'assets', 'config.js');
  assert.ok(existsSync(cfgPath), '缺少 assets/config.js');
  const cfg = readText(cfgPath);
  const apiBase = cfg.match(/"apiBase"\s*:\s*"([^"]+)"/)?.[1];
  const siteUrl = cfg.match(/"siteUrl"\s*:\s*"([^"]+)"/)?.[1];
  assert.ok(apiBase, 'config.js 应包含 apiBase');
  assert.ok(siteUrl, 'config.js 应包含 siteUrl');
  assert.equal(apiBase.replace(/\/+$/, ''), srv.base.replace(/\/+$/, ''), `apiBase 应等于构建所用 API: ${apiBase}`);
  assert.equal(siteUrl.replace(/\/+$/, ''), SITE, `siteUrl 应等于 SITE_URL: ${siteUrl}`);
});

test('404.html 含可读 404 提示与返回首页链接', async () => {
  requireBoot();
  const html = readText(path.join(DIST, '404.html'));
  assert.match(textOf(html), /404|未找到|不存在/i, '404 页应含可读提示');
  const links = allLinks(html, `${SITE}/404.html`);
  const home = links.find((l) => {
    const h = l.href;
    return h === '/' || h === './' || h === 'index.html' || /(^|\/)index\.html$/.test(h) || h === SITE || h === `${SITE}/`;
  });
  assert.ok(home, `404 页应有返回首页的链接（相对或 base 根路径），实际链接: ${links.map((l) => l.href).join(', ')}`);
});

test('自建板块出现在板块总览、首页侧栏导航与自己的分类页', async () => {
  requireBoot();
  const home = readText(path.join(DIST, 'index.html'));
  const categoryIndex = readText(path.join(DIST, 'category/index.html'));
  const catPage = readText(path.join(DIST, `c/${customCategory.slug}/index.html`));

  assert.ok(textOf(categoryIndex).includes(customCategory.name), '板块总览应列出自建板块');
  assert.ok(textOf(home).includes(customCategory.name), '首页侧栏/导航应出现自建板块');
  assert.ok(textOf(catPage).includes(customCategory.name), '自建板块分类页应包含名称');
  assert.equal(h1s(catPage).length, 1, '自建板块分类页应恰好 1 个 h1');
  assert.ok(
    allLinks(home, `${SITE}/`).some((l) => /\/category\/new\/?$/.test(new URL(l.href, `${SITE}/`).pathname)),
    '首页应有「新建板块」入口链接 /category/new/',
  );
});

test('/category/new/：SSR 表单存在、noindex,nofollow、无 /rules/ 链接', async () => {
  requireBoot();
  const html = readText(path.join(DIST, 'category/new/index.html'));
  const robots = (metaContent(html, 'robots') || '').toLowerCase().replace(/\s+/g, '');
  assert.match(robots, /noindex/, `新建板块页应 noindex，实际 ${robots}`);
  assert.match(robots, /nofollow/, `新建板块页应 nofollow，实际 ${robots}`);
  assert.match(html, /<form\b/i, '新建板块页应有表单（SSR）');
  assert.ok(!/\/rules(\/|["'#?])/.test(html), '新建板块页不应有已删除的 /rules/ 链接');
});

test('全站已删除社区规则与免责声明：无 /rules/ 链接与相关文案，注册页无 accept 勾选', async () => {
  requireBoot();
  const htmlFiles = files.filter((f) => f.rel.endsWith('.html'));
  const banned = ['社区规则', '免责声明', '免责', '合规', '负责任披露', '授权范围'];
  for (const f of htmlFiles) {
    const html = readText(f.abs);
    assert.ok(!/\/rules(\/|["'#?])/.test(html), `${f.rel} 仍包含已删除的 /rules/ 链接`);
    const t = textOf(html);
    for (const w of banned) {
      assert.ok(!t.includes(w), `${f.rel} 仍包含已删除文案「${w}」`);
    }
  }
  const reg = readText(path.join(DIST, 'register/index.html'));
  assert.ok(!/name=["']accept["']/i.test(reg), '注册页不应再有 accept 勾选字段');
  assert.ok(!/我已阅读并同意|同意社区规则/.test(textOf(reg)), '注册页不应再有同意规则文案');
});

test('板块总览 meta description 使用新板块名（越狱实战 / 模型漏洞）且无旧名', async () => {
  requireBoot();
  const html = readText(path.join(DIST, 'category/index.html'));
  const desc = metaContent(html, 'description') || '';
  assert.ok(!/越狱研究|模型漏洞报告/.test(desc), `板块总览 description 仍含旧板块名: ${desc}`);
  assert.match(desc, /越狱实战/, `description 应含新名称「越狱实战」: ${desc}`);
  assert.match(desc, /模型漏洞/, `description 应含新名称「模型漏洞」: ${desc}`);
});

test('匿名发布：作者显示「匿名用户」且不带 /u/ 主页链接', async () => {
  requireBoot();
  const file = findThreadFile(anonThreadId);
  assert.ok(file, '缺少匿名主题静态页');
  const html = readText(file.abs);
  const t = textOf(html);
  assert.ok(t.includes('匿名用户'), '匿名主题页应显示作者「匿名用户」');
  assert.ok(!/href="[^"]*\/u\/[^"]*%E5%8C%BF/.test(html), '匿名作者不应生成 /u/ 匿名用户 链接');
  assert.ok(!/href="[^"]*\/u\/匿名/.test(html), '匿名作者不应生成 /u/ 链接');

  const home = readText(path.join(DIST, 'index.html'));
  assert.ok(textOf(home).includes(`匿名主题验收 ${seed.stamp}`), '首页应出现匿名发布的主题');
});

test('发帖/回帖表单移除登录门槛并提示匿名发布；新建板块仍要求登录', async () => {
  requireBoot();
  const newHtml = readText(path.join(DIST, 'new/index.html'));
  assert.ok(!/data-auth-required/.test(newHtml), '发帖表单不应再有 data-auth-required');
  assert.match(textOf(newHtml), /匿名用户/, '发帖页应提示未登录将以匿名用户发布');

  const threadHtml = readText(findThreadFile(seed.threads[0].id).abs);
  const replyForm = (threadHtml.match(/<form[^>]*class="reply-box"[^>]*>/i) || [])[0] || '';
  assert.ok(replyForm, '帖子页应有回帖表单');
  assert.ok(!/data-auth-required/.test(replyForm), '回帖表单不应再有 data-auth-required');
  assert.match(textOf(threadHtml), /匿名用户/, '帖子页回帖区应提示匿名发布');

  const catNew = readText(path.join(DIST, 'category/new/index.html'));
  assert.match(catNew, /data-auth-required/, '新建板块表单应保留登录要求');
});

test('/about/ 无合规/免责段落（进攻方口吻）', async () => {
  requireBoot();
  const t = textOf(readText(path.join(DIST, 'about/index.html')));
  for (const w of ['免责', '合规', '负责任披露', '授权范围', '社区规则']) {
    assert.ok(!t.includes(w), `/about/ 仍包含已删除文案「${w}」`);
  }
});
