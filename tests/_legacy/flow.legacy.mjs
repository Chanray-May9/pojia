// tests/flow.test.mjs — 验收项 6：注册→登录→发帖→回帖→上线→首页/sitemap + 未登录拦截
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer,
  Client,
  makeCtx,
  csrfFrom,
  postFormOnce,
  registerViaContract,
  loginViaContract,
  createPostViaContract,
  replyViaContract,
  allLinks,
  textOf,
  locsOf,
} from './helpers.mjs';

const PORT = 4313;
let srv;
let bootError = null;

before(async () => {
  try {
    srv = await startServer({ port: PORT, dbFile: 'test-flow.db' });
  } catch (e) {
    bootError = e;
  }
});

after(async () => {
  if (srv) await srv.stop();
});

function requireBoot() {
  assert.equal(bootError, null, `站点启动失败: ${bootError && bootError.stack}`);
}

async function anonymousCsrf(client) {
  const home = await client.get('/');
  return csrfFrom(home.html);
}

test('未登录：GET /new 303 到 /login?next=，POST /new 不产生帖子', async () => {
  requireBoot();
  const anon = new Client(srv.base);
  const getNew = await anon.raw('GET', '/new');
  assert.equal(getNew.status, 303, `GET /new 未登录应 303，实际 ${getNew.status}`);
  assert.match(getNew.location || '', /^\/login\?next=/, `Location 应为 /login?next=...，实际 ${getNew.location}`);

  const ctx = makeCtx('anon');
  const csrf = await anonymousCsrf(anon);
  const post = await postFormOnce(anon, '/new', { category: 'jailbreak', title: ctx.title, body: ctx.body, _csrf: csrf });
  assert.ok(
    post.status === 303 || post.status === 401 || post.status === 403,
    `未登录 POST /new 应 303/401/403，实际 ${post.status}`,
  );
  if (post.status === 303) assert.match(post.location || '', /\/login/i, '未登录 POST 应重定向到登录页');

  const home = await anon.get('/');
  assert.ok(!textOf(home.html).includes(ctx.title), '未登录 POST 不应创建帖子');
});

test('注册 303 → /；重复用户名被拒（400/403）', async () => {
  requireBoot();
  const client = new Client(srv.base);
  const ctx = makeCtx('reg');
  const { res } = await registerViaContract(client, ctx);
  assert.equal(res.status, 303, `POST /register 成功应 303，实际 ${res.status}`);
  assert.equal(res.location || '/', '/', `注册成功 Location 应为 /，实际 ${res.location}`);

  // 重复注册（新匿名会话，避免登录态干扰）
  const dup = new Client(srv.base);
  const dupRes = await registerViaContract(dup, ctx);
  assert.ok([400, 403].includes(dupRes.res.status), `重复用户名应 400/403，实际 ${dupRes.res.status}`);
});

test('登录 303 → /；错误密码不通过', async () => {
  requireBoot();
  const owner = new Client(srv.base);
  const ctx = makeCtx('login');
  await registerViaContract(owner, ctx);

  const good = new Client(srv.base);
  const login = await loginViaContract(good, ctx);
  assert.equal(login.res.status, 303, `POST /login 成功应 303，实际 ${login.res.status}`);
  assert.equal(login.res.location || '/', '/', `登录成功 Location 应为 /，实际 ${login.res.location}`);

  const evil = new Client(srv.base);
  const page = await evil.get('/login');
  const csrf = csrfFrom(page.html);
  const bad = await postFormOnce(evil, '/login', { login: ctx.username, password: 'wrong-password-123', _csrf: csrf });
  assert.ok([400, 401, 403].includes(bad.status), `错误密码应被拒（400/401/403），实际 ${bad.status}`);
  const home = await evil.get('/');
  assert.ok(!textOf(home.html).includes(ctx.username) || !/退出|登出|logout/i.test(textOf(home.html)), '错误密码不应建立登录态');
});

test('全链路：注册 → 登录 → 发帖 303 /t/:id-slug → 回帖 → 帖子上线 → 首页/sitemap', async () => {
  requireBoot();
  const client = new Client(srv.base);
  const ctx = makeCtx('flow');

  // 1) 注册 + 登录
  const reg = await registerViaContract(client, ctx);
  assert.equal(reg.res.status, 303);
  const login = await loginViaContract(client, ctx);
  assert.equal(login.res.status, 303);

  // 2) 登录后 GET /new 正常
  const newPage = await client.get('/new?category=jailbreak');
  assert.equal(newPage.status, 200, `登录后 GET /new 应 200，实际 ${newPage.status}`);

  // 3) 发帖 → 303 /t/<id>-<slug>
  const created = await createPostViaContract(client, ctx);
  assert.equal(created.res.status, 303);
  assert.match(
    created.location,
    /^\/t\/\d+(?:-[A-Za-z0-9._~%:-]+)?$/,
    `发帖 Location 应形如 /t/<id>-<slug>，实际 ${created.location}`,
  );
  // 中文标题的 slug 必须做 ASCII/百分号处理，不能把非 ASCII 直接写进响应头
  assert.match(created.location, /^[\x20-\x7e]+$/, `Location 响应头必须为 ASCII，实际 ${created.location}`);

  // 4) 帖子上线：200 且内容 SSR
  const postPage = await client.get(created.postPath);
  assert.equal(postPage.status, 200, `帖子页应 200，实际 ${postPage.status}`);
  const postText = textOf(postPage.html);
  assert.ok(postText.includes(ctx.title), '帖子页应包含标题');
  assert.ok(postText.includes(ctx.body.split('marker')[0].trim()), '帖子页应包含正文');
  const canonical = postPage.html.match(/rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  assert.ok(canonical, '帖子页应有 canonical');

  // 5) 回帖 → 303 回帖子页，内容出现
  ctx.replyText = `回帖验收 marker reply-${ctx.stamp}`;
  const reply = await replyViaContract(client, created.postPath, ctx.replyText, ctx);
  assert.equal(reply.res.status, 303, `回帖应 303，实际 ${reply.res.status}`);
  assert.equal(new URL(reply.res.location, srv.base).pathname, created.postPath, '回帖后应回到帖子页');
  const afterReply = await client.get(created.postPath);
  assert.ok(textOf(afterReply.html).includes(ctx.replyText), '回帖内容应出现在帖子页');
  assert.match(
    afterReply.html,
    /(2\s*楼|#\s*0?2\b|post-floor[^>]*>\s*#?\s*0?2|data-floor=["']?0?2)/i,
    '回帖楼层号应 >= 2（应出现 #2 / #02 楼层标记）',
  );

  // 6) 首页出现帖子链接
  const home = await client.get('/');
  assert.ok(textOf(home.html).includes(ctx.title), '首页应出现新帖标题');
  const link = allLinks(home.html, home.url).find((l) => l.text.includes(ctx.title));
  assert.ok(link, '首页应有新帖链接');
  assert.equal(new URL(link.href).pathname, created.postPath, '首页链接应指向该帖');

  // 7) sitemap 出现帖子
  const sitemap = await client.get('/sitemap.xml');
  assert.ok(
    locsOf(sitemap.html).some((l) => new URL(l).pathname.replace(/\/+$/, '') === created.postPath),
    `sitemap 应包含新帖 ${created.postPath}`,
  );

  // 8) 帖子可从搜索命中
  const search = await client.get(`/search?q=${encodeURIComponent(ctx.title)}`);
  assert.equal(search.status, 200);
  assert.ok(textOf(search.html).includes(ctx.title), '搜索应命中新帖');

  // 9) 退出登录 → 再发帖被拦截
  const logoutCsrf = csrfFrom((await client.get('/')).html);
  const logout = await postFormOnce(client, '/logout', { _csrf: logoutCsrf });
  assert.equal(logout.status, 303, `POST /logout 应 303，实际 ${logout.status}`);
  const afterLogout = await client.raw('GET', '/new');
  assert.equal(afterLogout.status, 303, '登出后 GET /new 应 303 到登录页');
});

test('表单校验：标题过短/正文过短 → 400 且不创建帖子', async () => {
  requireBoot();
  const client = new Client(srv.base);
  const ctx = makeCtx('valid');
  await registerViaContract(client, ctx);
  await loginViaContract(client, ctx);

  const page = await client.get('/new?category=jailbreak');
  const csrf = csrfFrom(page.html);
  const shortTitle = await postFormOnce(client, '/new', { category: 'jailbreak', title: '短', body: '这是一段足够长的正文内容用于校验。', _csrf: csrf });
  assert.equal(shortTitle.status, 400, `标题过短应 400，实际 ${shortTitle.status}`);
  assert.match(shortTitle.contentType, /text\/html/i, '校验失败应返回 HTML 错误页');

  const page2 = await client.get('/new?category=jailbreak');
  const csrf2 = csrfFrom(page2.html);
  const shortBody = await postFormOnce(client, '/new', { category: 'jailbreak', title: '这是一个长度合法的测试标题', body: '短', _csrf: csrf2 });
  assert.equal(shortBody.status, 400, `正文过短应 400，实际 ${shortBody.status}`);

  const home = await client.get('/');
  assert.ok(!textOf(home.html).includes('这是一个长度合法的测试标题'), '校验失败不应创建帖子');
});

test('CSRF：缺少 _csrf 的写请求被拒（400/403）', async () => {
  requireBoot();
  const client = new Client(srv.base);
  const ctx = makeCtx('csrf');
  await registerViaContract(client, ctx);
  await loginViaContract(client, ctx);

  const noCsrf = await postFormOnce(client, '/new', { category: 'jailbreak', title: ctx.title, body: ctx.body });
  assert.ok([400, 403].includes(noCsrf.status), `缺 _csrf 应 400/403，实际 ${noCsrf.status}`);
});
