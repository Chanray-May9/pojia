// tests/seo.test.mjs — 验收项 3/4/8：title/description/canonical/OG/Twitter/h1/JSON-LD/noindex
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer,
  Client,
  seedViaContract,
  titleOf,
  titlesOf,
  h1s,
  metaContent,
  canonicalOf,
  parseLdJson,
  jsonLdTypes,
  metas,
  normalizeUrl,
} from './helpers.mjs';

const PORT = 4311;
let srv;
let client;
let seed;
let bootError = null;

before(async () => {
  try {
    srv = await startServer({ port: PORT, dbFile: 'test-seo.db' });
    client = new Client(srv.base);
    seed = await seedViaContract(client);
  } catch (e) {
    bootError = e;
  }
});

after(async () => {
  if (srv) await srv.stop();
});

function requireBoot() {
  assert.equal(bootError, null, `站点启动/播种失败: ${bootError && bootError.stack}`);
}

const publicPages = () => ['/', '/c/jailbreak', seed.post.postPath, '/search?q=qa'];

test('每页恰好一个 <title> 且各页标题唯一非空', async () => {
  requireBoot();
  const seen = new Map();
  for (const p of publicPages()) {
    const res = await client.get(p);
    assert.equal(res.status, 200, `${p} 200`);
    const titles = titlesOf(res.html);
    assert.equal(titles.length, 1, `${p} 应有且仅有 1 个 <title>，实际 ${titles.length}`);
    assert.ok(titles[0].length >= 6, `${p} 标题过短: ${JSON.stringify(titles[0])}`);
    assert.ok(!seen.has(titles[0]), `${p} 标题与其他页重复: ${titles[0]}（另见 ${seen.get(titles[0])}）`);
    seen.set(titles[0], p);
  }
});

test('每页有非空 meta description，且 og:title/og:description/og:url/og:type/twitter:card', async () => {
  requireBoot();
  for (const p of publicPages()) {
    const res = await client.get(p);
    const desc = metaContent(res.html, 'description');
    assert.ok(desc && desc.trim().length >= 10, `${p} 缺少/过短的 meta description: ${JSON.stringify(desc)}`);

    assert.ok(metaContent(res.html, 'og:title'), `${p} 缺少 og:title`);
    assert.ok(metaContent(res.html, 'og:description'), `${p} 缺少 og:description`);
    assert.ok(metaContent(res.html, 'og:url'), `${p} 缺少 og:url`);
    assert.ok(metaContent(res.html, 'og:type'), `${p} 缺少 og:type`);

    const twitterCard = metaContent(res.html, 'twitter:card');
    assert.ok(twitterCard, `${p} 缺少 twitter:card`);
    assert.match(twitterCard, /summary/i, `${p} twitter:card 应为 summary/summary_large_image`);
  }
});

test('每页 canonical 自引用且使用 SITE_URL 源', async () => {
  requireBoot();
  for (const p of publicPages()) {
    const res = await client.get(p);
    const canonical = canonicalOf(res.html);
    assert.ok(canonical, `${p} 缺少 rel=canonical`);
    const c = new URL(canonical);
    const expected = new URL(res.url);
    assert.equal(c.origin, expected.origin, `${p} canonical 源应为 ${expected.origin}，实际 ${c.origin}`);
    if (p.startsWith('/search')) {
      assert.match(c.pathname, /^\/search/, `${p} canonical path 应为 /search，实际 ${c.pathname}`);
    } else {
      assert.equal(
        normalizeUrl(canonical),
        normalizeUrl(res.url),
        `${p} canonical 应自引用 ${normalizeUrl(res.url)}，实际 ${normalizeUrl(canonical)}`,
      );
    }
  }
});

test('每页有且仅有一个 h1', async () => {
  requireBoot();
  for (const p of publicPages()) {
    const res = await client.get(p);
    const hs = h1s(res.html);
    assert.equal(hs.length, 1, `${p} 应恰好 1 个 h1，实际 ${hs.length}: ${JSON.stringify(hs)}`);
    assert.ok(hs[0].length > 0, `${p} h1 不应为空`);
  }
});

test('JSON-LD 均可 JSON.parse 且类型符合页面（WebSite / DiscussionForumPosting / BreadcrumbList）', async () => {
  requireBoot();
  const home = await client.get('/');
  const homeLd = parseLdJson(home.html);
  assert.deepEqual(homeLd.errors, [], `首页 JSON-LD 解析错误: ${JSON.stringify(homeLd.errors)}`);
  assert.ok(homeLd.blocks.length > 0, '首页应有 JSON-LD');
  assert.ok(jsonLdTypes(homeLd.blocks).has('WebSite'), `首页 JSON-LD 应含 WebSite，实际 ${[...jsonLdTypes(homeLd.blocks)].join(',')}`);

  const post = await client.get(seed.post.postPath);
  const postLd = parseLdJson(post.html);
  assert.deepEqual(postLd.errors, [], `帖子页 JSON-LD 解析错误: ${JSON.stringify(postLd.errors)}`);
  const postTypes = jsonLdTypes(postLd.blocks);
  assert.ok(
    postTypes.has('DiscussionForumPosting'),
    `帖子页 JSON-LD 应含 DiscussionForumPosting，实际 ${[...postTypes].join(',')}`,
  );
  const posting = postLd.blocks.find((b) => b && (b['@type'] === 'DiscussionForumPosting' || (Array.isArray(b['@type']) && b['@type'].includes('DiscussionForumPosting'))));
  assert.equal(String(posting?.headline || '').trim(), seed.ctx.title, 'JSON-LD headline 应等于帖子标题');

  const cat = await client.get('/c/jailbreak');
  const catLd = parseLdJson(cat.html);
  assert.deepEqual(catLd.errors, [], `分类页 JSON-LD 解析错误: ${JSON.stringify(catLd.errors)}`);
  const catTypes = jsonLdTypes(catLd.blocks);
  assert.ok(catTypes.has('BreadcrumbList'), `分类页 JSON-LD 应含 BreadcrumbList，实际 ${[...catTypes].join(',')}`);

  // 搜索页若输出 JSON-LD 也必须可解析
  const search = await client.get('/search?q=qa');
  const searchLd = parseLdJson(search.html);
  assert.deepEqual(searchLd.errors, [], `搜索页 JSON-LD 解析错误: ${JSON.stringify(searchLd.errors)}`);
});

test('登录后页面 /new /settings /notifications 带 noindex', async () => {
  requireBoot();
  for (const p of ['/new', '/settings', '/notifications']) {
    const res = await client.get(p);
    assert.equal(res.status, 200, `${p} 登录后应 200，实际 ${res.status}`);
    const robots = (metaContent(res.html, 'robots') || '').toLowerCase();
    assert.match(robots, /noindex/, `${p} 应带 noindex，实际 robots=${JSON.stringify(robots)}`);
  }
});

test('搜索页 meta robots 为 noindex,follow', async () => {
  requireBoot();
  const res = await client.get('/search?q=qa');
  assert.equal(res.status, 200);
  const robots = (metaContent(res.html, 'robots') || '').toLowerCase().replace(/\s+/g, '');
  assert.match(robots, /noindex/, `搜索页应 noindex，实际 robots=${JSON.stringify(robots)}`);
  assert.match(robots, /follow/, `搜索页应 follow，实际 robots=${JSON.stringify(robots)}`);
});

test('登录/注册页带 noindex（不索引认证页）', async () => {
  requireBoot();
  for (const p of ['/login', '/register']) {
    const res = await client.get(p);
    const robots = (metaContent(res.html, 'robots') || '').toLowerCase();
    assert.match(robots, /noindex/, `${p} 应带 noindex，实际 robots=${JSON.stringify(robots)}`);
  }
});
