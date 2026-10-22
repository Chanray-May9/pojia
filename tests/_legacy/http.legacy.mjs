// tests/http.test.mjs — 验收项 1/2：状态码语义 + 服务端渲染（无 JS）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, seedViaContract, textOf, allLinks, formWithPassword, parseForms, discoverSearch, searchUrl } from './helpers.mjs';

const PORT = 4310;
let srv;
let client;
let seed;
let bootError = null;

before(async () => {
  try {
    srv = await startServer({ port: PORT, dbFile: 'test-http.db' });
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

test('公开页面均返回 HTTP 200 且为 HTML', async () => {
  requireBoot();
  const pages = ['/', '/c/jailbreak', seed.post.postPath, '/rules', '/about', '/category', `/u/${seed.ctx.username}`, '/login', '/register'];
  for (const p of pages) {
    const res = await client.get(p);
    assert.equal(res.status, 200, `${p} 状态码应为 200，实际 ${res.status}`);
    assert.match(res.contentType, /text\/html/i, `${p} Content-Type 应为 text/html，实际 ${res.contentType}`);
  }
});

test('未知路径返回 404 状态码且渲染 HTML 404 页', async () => {
  requireBoot();
  const res = await client.get('/definitely-not-a-real-page-qa-404');
  assert.equal(res.status, 404, '未知路径应为 404');
  assert.match(res.contentType, /text\/html/i, '404 页应为 HTML');
  assert.match(textOf(res.html), /404|未找到|不存在|not found/i, '404 页应包含可读提示');
});

test('搜索结果页 200，且能检索到新帖', async () => {
  requireBoot();
  const search = await discoverSearch(client);
  const res = await client.get(searchUrl(search, seed.ctx.title));
  assert.equal(res.status, 200);
  assert.ok(textOf(res.html).includes(seed.ctx.title), '搜索结果应包含刚发布的帖子标题');
});

test('robots.txt / sitemap.xml / feed.xml 返回 200 且 Content-Type 符合契约', async () => {
  requireBoot();
  const robots = await client.get('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.contentType, /text\/plain/i, `robots Content-Type=${robots.contentType}`);

  const sitemap = await client.get('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.contentType, /(application|text)\/xml/i, `sitemap Content-Type=${sitemap.contentType}`);

  const feed = await client.get('/feed.xml');
  assert.equal(feed.status, 200);
  assert.match(feed.contentType, /(application|text)\/xml/i, `feed Content-Type=${feed.contentType}`);
});

test('首页服务端渲染出分类导航与帖子列表（不依赖 JS）', async () => {
  requireBoot();
  const res = await client.get('/');
  assert.equal(res.status, 200);
  const text = textOf(res.html);
  // 分类名来自契约：jailbreak/injection/... 至少首页出现多个
  const visibleCategories = ['jailbreak', 'injection', 'redteam', 'defense', 'tooling', 'vuln', 'general'].filter((c) =>
    text.includes(c),
  );
  assert.ok(visibleCategories.length >= 3, `首页应出现分类导航，实际可见: ${visibleCategories.join(',') || '无'}`);
  // 新帖出现在首页列表
  assert.ok(text.includes(seed.ctx.title), '首页应包含刚发布帖子标题');
  const link = allLinks(res.html, res.url).find((l) => l.text.includes(seed.ctx.title));
  assert.ok(link, '首页应有指向新帖的 <a> 链接');
  assert.match(link.href, /\/t\/\d+-/, `帖子链接应形如 /t/<id>-<slug>，实际 ${link.href}`);
});

test('分类页服务端渲染出帖子条目', async () => {
  requireBoot();
  const res = await client.get('/c/jailbreak');
  assert.equal(res.status, 200);
  assert.ok(textOf(res.html).includes(seed.ctx.title), '分类页 /c/jailbreak 应包含新帖标题');
});

test('帖子页服务端渲染标题、正文与回帖（纯 HTML）', async () => {
  requireBoot();
  const res = await client.get(seed.post.postPath);
  assert.equal(res.status, 200);
  const text = textOf(res.html);
  assert.ok(text.includes(seed.ctx.title), '帖子页应包含标题');
  assert.ok(text.includes(seed.ctx.body.split('marker')[0].trim()), '帖子页应包含正文');
  assert.ok(text.includes(seed.ctx.replyText), '帖子页应包含回帖内容');
  assert.ok(text.includes(seed.ctx.username), '帖子页应显示作者用户名');
});

test('注册/登录页含 password 表单（SSR，可无 JS 提交）', async () => {
  requireBoot();
  for (const p of ['/register', '/login']) {
    const res = await client.get(p);
    assert.equal(res.status, 200);
    const form = formWithPassword(parseForms(res.html, res.url));
    assert.ok(form, `${p} 应有含 password 的 <form>`);
    assert.ok(form.fields.some((f) => f.name === '_csrf'), `${p} 表单应含 _csrf 隐藏字段`);
  }
});

test('未登录访问 /new 被拦截（303 到登录页）', async () => {
  requireBoot();
  const anon = new Client(srv.base);
  const res = await anon.raw('GET', '/new');
  assert.equal(res.status, 303, '/new 未登录应 303');
  assert.match(res.location || '', /\/login/i, `Location 应指向 /login，实际 ${res.location}`);
});
