// tests/crawl.test.mjs — 验收项 5：robots.txt / sitemap.xml / feed.xml
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, seedViaContract, locsOf } from './helpers.mjs';

const PORT = 4312;
let srv;
let client;
let seed;
let bootError = null;

before(async () => {
  try {
    srv = await startServer({ port: PORT, dbFile: 'test-crawl.db' });
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

const PRIVATE = [/\/login\b/i, /\/register\b/i, /\/new\b/i, /\/settings\b/i, /\/notifications\b/i, /\/search\b/i, /\/admin\b/i, /\/api\b/i, /\/logout\b/i];

test('robots.txt 为 text/plain 且含 Sitemap 绝对地址', async () => {
  requireBoot();
  const res = await client.get('/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/plain/i);
  const text = res.html;
  assert.match(text, /User-agent:\s*\*/i, 'robots.txt 应含 User-agent: *');
  const sitemapLine = text.match(/Sitemap:\s*(\S+)/i);
  assert.ok(sitemapLine, 'robots.txt 应含 Sitemap: 行');
  assert.match(sitemapLine[1], /^https?:\/\/127\.0\.0\.1:4312\/sitemap\.xml$/i, `Sitemap 应为绝对地址指向本站，实际 ${sitemapLine[1]}`);
});

test('robots.txt 声明禁止抓取私有/登录后路径', async () => {
  requireBoot();
  const res = await client.get('/robots.txt');
  const text = res.html;
  const disallows = [...text.matchAll(/Disallow:\s*(\S+)/gi)].map((m) => m[1]);
  assert.ok(disallows.length > 0, 'robots.txt 应有 Disallow 行');
  for (const required of ['/login', '/new']) {
    assert.ok(
      disallows.some((d) => d.startsWith(required)),
      `robots.txt 应 Disallow ${required}，实际 ${JSON.stringify(disallows)}`,
    );
  }
});

test('sitemap.xml 结构合法（XML 声明/urlset/loc 绝对 URL）', async () => {
  requireBoot();
  const res = await client.get('/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /(application|text)\/xml/i);
  const xml = res.html.trim();
  assert.match(xml, /^<\?xml\s+version=["']1\.0["']/i, 'sitemap 应以 XML 声明开头');
  assert.match(xml, /<urlset\b[^>]*xmlns=["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/i, 'sitemap 应含 urlset + 标准命名空间');
  assert.match(xml, /<\/urlset>\s*$/i, 'sitemap 应以 </urlset> 结束');

  const locs = locsOf(xml);
  assert.ok(locs.length >= 3, `sitemap 应包含首页/分类/帖子等多个 URL，实际 ${locs.length}`);
  for (const loc of locs) {
    assert.match(loc, /^https?:\/\/127\.0\.0\.1:4312\//, `sitemap loc 应为本站绝对 URL: ${loc}`);
    assert.doesNotThrow(() => new URL(loc), `非法 URL: ${loc}`);
  }
});

test('sitemap.xml 只含公开可索引 URL（无登录/后台/搜索/发帖）', async () => {
  requireBoot();
  const res = await client.get('/sitemap.xml');
  const locs = locsOf(res.html);
  for (const loc of locs) {
    const pathname = new URL(loc).pathname;
    for (const re of PRIVATE) {
      assert.ok(!re.test(pathname), `sitemap 不应包含私有/不可索引 URL: ${loc}（命中 ${re}）`);
    }
  }
});

test('sitemap.xml 包含首页、分类页与新发布帖子，且这些 URL 可 200 访问', async () => {
  requireBoot();
  const res = await client.get('/sitemap.xml');
  const locs = locsOf(res.html).map((l) => l.replace(/\/+$/, ''));
  const norm = (u) => u.replace(/\/+$/, '');
  assert.ok(
    locs.some((l) => norm(l) === norm(srv.base) || norm(l) === norm(srv.base + '/')),
    `sitemap 应包含首页 ${srv.base}，实际: ${locs.join(', ')}`,
  );
  assert.ok(
    locs.some((l) => l.endsWith('/c/jailbreak')),
    `sitemap 应包含分类页 /c/jailbreak，实际: ${locs.join(', ')}`,
  );
  assert.ok(
    locs.some((l) => l.endsWith(norm(seed.post.postPath))),
    `sitemap 应包含新帖 ${seed.post.postPath}，实际: ${locs.join(', ')}`,
  );

  const sample = locs.slice(0, 12);
  for (const loc of sample) {
    const r = await client.raw('GET', loc);
    assert.equal(r.status, 200, `sitemap 中的 URL 应可访问 200: ${loc} -> ${r.status}`);
  }
});

test('feed.xml 为合法 XML 且包含新帖', async () => {
  requireBoot();
  const res = await client.get('/feed.xml');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /(application|text)\/xml/i);
  const xml = res.html.trim();
  assert.match(xml, /^<\?xml\s+version=["']1\.0["']/i, 'feed 应以 XML 声明开头');
  assert.match(xml, /<rss\b|<feed\b/i, 'feed 应为 RSS/Atom');
  assert.match(xml, /<\/rss>|<\/feed>/i, 'feed 应闭合');
  assert.ok(xml.includes(seed.ctx.title) || xml.includes(seed.ctx.stamp), 'feed 应包含新帖标题/marker');
});
