// tests/api.test.mjs — A. 后端 API 功能验收（本地 Worker 代码 + node:sqlite D1 shim）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startApi,
  apiFetch,
  seedForum,
  registerApi,
  loginApi,
  makeUser,
  createThreadApi,
} from './helpers.mjs';

const PORT = 4410;
let srv;
let bootError = null;
let seed;
let categories = [];
let catTokens = [];

before(async () => {
  try {
    srv = await startApi({ port: PORT, dbFile: 'api-test.db' });
    const catRes = await apiFetch(srv.base, 'GET', '/api/v1/categories');
    categories = (catRes.json?.categories || []).map((c) => c.slug).filter(Boolean);
    seed = await seedForum(srv.base);
    // 预先注册两个用户供自建板块测试复用（避免触发注册限流）
    for (let i = 0; i < 2; i++) {
      const reg = await registerApi(srv.base, makeUser('cat'));
      catTokens.push(reg.json.token);
    }
  } catch (e) {
    bootError = e;
  }
});

after(async () => {
  if (srv) await srv.stop();
});

function requireBoot() {
  assert.equal(bootError, null, `后端启动/播种失败: ${bootError && bootError.stack}`);
}

test('GET /api/health 返回 200 JSON {ok,version,time}', async () => {
  requireBoot();
  const res = await apiFetch(srv.base, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/json/i);
  assert.equal(res.json?.ok, true, `health.ok 应为 true，实际 ${JSON.stringify(res.json)}`);
  assert.ok(res.json?.version, 'health 应含 version');
  assert.ok(!Number.isNaN(Date.parse(res.json?.time || '')), 'health.time 应为可解析时间');
});

test('GET /api/v1/site 公开快照含 stats/categories/threads 且 threads 带正文与回复', async () => {
  requireBoot();
  const res = await apiFetch(srv.base, 'GET', '/api/v1/site');
  assert.equal(res.status, 200);
  assert.ok(res.json?.generated_at, 'site 快照应含 generated_at');
  assert.ok(res.json?.stats && typeof res.json.stats === 'object', 'site 快照应含 stats');
  assert.ok(Array.isArray(res.json?.categories) && res.json.categories.length > 0, 'site 快照应含 categories');
  assert.ok(Array.isArray(res.json?.threads) && res.json.threads.length > 0, 'site 快照应含 threads');
  const thread = res.json.threads.find((t) => t.id === seed.threads[0].id);
  assert.ok(thread, 'site 快照应包含刚创建的主题');
  assert.ok(String(thread.body || '').length > 10, 'site 快照 threads 应含正文（SSG 需要）');
  assert.ok(Array.isArray(thread.posts) || Array.isArray(thread.replies), 'site 快照 threads 应含回复列表');
});

test('GET /api/v1/categories 返回板块列表（含 slug/name/主题数）', async () => {
  requireBoot();
  const res = await apiFetch(srv.base, 'GET', '/api/v1/categories');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json?.categories) && res.json.categories.length > 0);
  for (const c of res.json.categories) {
    assert.ok(c.slug && typeof c.slug === 'string', `板块缺少 slug: ${JSON.stringify(c)}`);
    assert.ok(c.name || c.title, `板块缺少名称: ${JSON.stringify(c)}`);
    assert.ok(Number.isFinite(Number(c.thread_count ?? c.threads_count ?? 0)), '板块应含主题数');
  }
});

test('GET /api/v1/threads 列表：分页、分类过滤、含模型标签/验证等级', async () => {
  requireBoot();
  const list = await apiFetch(srv.base, 'GET', '/api/v1/threads?page=1&page_size=2');
  assert.equal(list.status, 200);
  const threads = list.json?.threads || [];
  assert.ok(threads.length <= 2, `page_size=2 时最多 2 条，实际 ${threads.length}`);
  const pg = list.json?.pagination || list.json;
  assert.equal(Number(pg.page_size), 2, '分页信息应回显 page_size');
  assert.equal(Number(pg.page), 1, '分页信息应回显 page');
  for (const t of threads) {
    assert.ok(Number.isFinite(Number(t.id)), '列表项应含 id');
    assert.ok(t.title, '列表项应含标题');
    assert.ok(Array.isArray(t.models), `列表项 models 应为数组: ${JSON.stringify(t.models)}`);
    assert.ok(Array.isArray(t.model_labels), '列表项应带 model_labels 数组');
    assert.ok(['none', 'self', 'admin'].includes(t.verification), `verification 值非法: ${t.verification}`);
    assert.ok(t.verification_label, '列表项应带 verification_label');
  }

  const catSlug = seed.threads[0].category || categories[0];
  const filtered = await apiFetch(srv.base, 'GET', `/api/v1/threads?category=${encodeURIComponent(catSlug)}`);
  assert.equal(filtered.status, 200);
  for (const t of filtered.json?.threads || []) {
    assert.equal(t.category, catSlug, `分类过滤失效: ${t.category} != ${catSlug}`);
  }
});

test('GET /api/v1/threads/:id 详情含回复与标注；未知 id 404', async () => {
  requireBoot();
  const id = seed.threads[0].id;
  const res = await apiFetch(srv.base, 'GET', `/api/v1/threads/${id}`);
  assert.equal(res.status, 200);
  const t = res.json?.thread || res.json;
  assert.equal(Number(t.id), Number(id));
  assert.ok(res.json?.thread || res.json?.posts || res.json?.replies, '详情应含 thread 与回复结构');
  const posts = res.json?.thread?.posts || res.json?.thread?.replies || res.json?.posts || res.json?.replies || [];
  assert.ok(Array.isArray(posts) && posts.length >= 1, '详情应包含回帖');

  const missing = await apiFetch(srv.base, 'GET', '/api/v1/threads/999999');
  assert.equal(missing.status, 404, `未知主题应 404，实际 ${missing.status}`);
  assert.ok(missing.json?.error, '404 应返回 JSON error');
});

test('注册 201 返回 token/user/redirect；重复/非法输入 400', async () => {
  requireBoot();
  const u = makeUser('api');
  const reg = await registerApi(srv.base, u);
  assert.equal(reg.status, 201);
  assert.ok(reg.json?.token && reg.json.token.length >= 20, '注册应返回 Bearer token');
  assert.equal(reg.json?.user?.username, u.username);
  assert.equal(reg.json?.redirect, '/');

  const dup = await apiFetch(srv.base, 'POST', '/auth/register', { body: u });
  assert.ok([400, 409].includes(dup.status), `重复用户名应 400/409，实际 ${dup.status}`);
  assert.ok(dup.json?.error, '重复注册响应应含 error');

  const badPwd = await apiFetch(srv.base, 'POST', '/auth/register', {
    body: { ...makeUser('api'), password: 'short' },
  });
  assert.equal(badPwd.status, 400, `弱密码应 400，实际 ${badPwd.status}`);
  assert.ok(badPwd.json?.error, '错误响应应含 error 字段');
});

test('登录 200 返回 token；错误密码 401/400', async () => {
  requireBoot();
  const u = makeUser('api');
  await registerApi(srv.base, u);
  const ok = await loginApi(srv.base, u.username, u.password);
  assert.equal(ok.status, 200);
  assert.ok(ok.json?.token, '登录应返回 token');
  assert.equal(ok.json?.redirect, '/');

  const bad = await apiFetch(srv.base, 'POST', '/auth/login', {
    body: { login: u.username, password: 'wrong-password-xyz' },
  });
  assert.ok([400, 401].includes(bad.status), `错误密码应 400/401，实际 ${bad.status}`);
});

test('GET /auth/me 与 POST /auth/logout：Bearer 生效与失效', async () => {
  requireBoot();
  const u = makeUser('api');
  const reg = await registerApi(srv.base, u);
  const token = reg.json.token;

  const me = await apiFetch(srv.base, 'GET', '/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json?.user?.username, u.username);

  const logout = await apiFetch(srv.base, 'POST', '/auth/logout', { token });
  assert.equal(logout.status, 200);
  assert.equal(logout.json?.ok, true);

  const meAfter = await apiFetch(srv.base, 'GET', '/auth/me', { token });
  assert.equal(meAfter.status, 401, `登出后 token 应失效（401），实际 ${meAfter.status}`);
});

test('发帖：201 + redirect /t/<id>-<slug>；匿名发帖 201；无效 Bearer 401；非法参数 400', async () => {
  requireBoot();
  const catSlug = seed.threads[0].category || categories[0];
  const title = `API 发帖验收 ${Date.now().toString(36)}`;
  const res = await createThreadApi(srv.base, seed.token, {
    category: catSlug,
    title,
    body: 'API 发帖正文，长度足够用于校验。',
    models: ['gpt'],
    verification: 'self',
  });
  assert.equal(res.status, 201);
  const thread = res.json?.thread;
  assert.ok(thread?.id, '返回应含 thread.id');
  assert.match(res.json?.redirect || '', /^\/t\/\d+-[^/]+\/$/, `redirect 应形如 /t/<id>-<slug>/，实际 ${res.json?.redirect}`);
  assert.deepEqual(thread.models, ['gpt'], `thread.models 应为数组 ['gpt']，实际 ${JSON.stringify(thread.models)}`);
  assert.ok(Array.isArray(thread.model_labels) && thread.model_labels.length === 1, 'thread 应带 model_labels 中文标签数组');
  assert.equal(thread.verification, 'self', 'thread.verification 应为 self');
  assert.ok(thread.verification_label, 'thread 应带 verification_label 中文文案');

  // 匿名发帖：完全不带 Authorization → 201，作者显示为匿名用户（新需求）
  const anonTitle = `匿名发帖验收 ${Date.now().toString(36)}`;
  const anon = await apiFetch(srv.base, 'POST', '/threads', {
    body: { category: catSlug, title: anonTitle, body: '未登录正文长度足够，允许匿名发布。', verification: 'none' },
  });
  assert.equal(anon.status, 201, `匿名发帖应 201，实际 ${anon.status} ${anon.text.slice(0, 200)}`);
  assert.equal(anon.json?.thread?.author, '匿名用户', '匿名帖作者应为匿名用户');
  const anonDetail = await apiFetch(srv.base, 'GET', `/threads/${anon.json.thread.id}`);
  assert.equal(anonDetail.json?.thread?.author, '匿名用户', '匿名帖详情作者应为匿名用户');

  // 带了无效 Bearer → 401，不静默降级为匿名
  const forged = await apiFetch(srv.base, 'POST', '/threads', {
    token: 'forged-token-abc',
    body: { category: catSlug, title: '伪造 token 发帖', body: '正文长度足够用于校验。' },
  });
  assert.equal(forged.status, 401, `无效 Bearer 发帖应 401，实际 ${forged.status}`);
  assert.equal(forged.json?.error, 'invalid_token', `错误码应为 invalid_token，实际 ${forged.json?.error}`);

  const badCat = await apiFetch(srv.base, 'POST', '/threads', {
    token: seed.token,
    body: { category: 'no-such-category', title: '非法分类测试', body: '正文长度足够用于校验。' },
  });
  assert.equal(badCat.status, 400, `非法分类应 400，实际 ${badCat.status}`);

  const badModel = await apiFetch(srv.base, 'POST', '/threads', {
    token: seed.token,
    body: { category: catSlug, title: '非法模型测试', body: '正文长度足够用于校验。', models: ['not-a-model-id'] },
  });
  assert.equal(badModel.status, 400, `非法模型 id 应 400，实际 ${badModel.status}`);

  const tooMany = await apiFetch(srv.base, 'POST', '/threads', {
    token: seed.token,
    body: {
      category: catSlug,
      title: '模型数量超限测试',
      body: '正文长度足够用于校验。',
      models: ['gpt', 'claude', 'gemini', 'llama'],
    },
  });
  assert.equal(tooMany.status, 400, `模型超过 3 个应 400，实际 ${tooMany.status}`);

  const adminByUser = await apiFetch(srv.base, 'POST', '/threads', {
    token: seed.token,
    body: {
      category: catSlug,
      title: '普通用户冒充复核',
      body: '正文长度足够用于校验。',
      verification: 'admin',
    },
  });
  assert.ok(
    [400, 403].includes(adminByUser.status),
    `普通用户设置 verification=admin 应被拒（400/403），实际 ${adminByUser.status}`,
  );

  // models 选 other 时必须提供 model_custom；提供后应成功
  const otherNoCustom = await apiFetch(srv.base, 'POST', '/threads', {
    token: seed.token,
    body: {
      category: catSlug,
      title: 'other 未填自定义模型',
      body: '正文长度足够用于校验。',
      models: ['other'],
    },
  });
  assert.equal(otherNoCustom.status, 400, `models 含 other 但缺 model_custom 应 400，实际 ${otherNoCustom.status}`);

  const otherWithCustom = await apiFetch(srv.base, 'POST', '/threads', {
    token: seed.token,
    body: {
      category: catSlug,
      title: 'other 已填自定义模型',
      body: '正文长度足够用于校验。',
      models: ['other'],
      model_custom: '内部自研模型 v1',
    },
  });
  assert.equal(otherWithCustom.status, 201, `other + model_custom 应成功，实际 ${otherWithCustom.status}`);
});

test('回帖：201 + redirect #p<id>；匿名回帖 201；无效 Bearer 401；空内容 400；未知主题 404', async () => {
  requireBoot();
  const id = seed.threads[0].id;
  const res = await apiFetch(srv.base, 'POST', `/threads/${id}/replies`, {
    token: seed.token,
    body: { body: `API 回帖验收 ${Date.now().toString(36)}` },
  });
  assert.equal(res.status, 201);
  assert.ok(res.json?.post?.id, '回帖响应应含 post.id');
  assert.match(res.json?.redirect || '', new RegExp(`^/t/${id}-[^/]+/#p${res.json?.post?.id}$`));

  const anon = await apiFetch(srv.base, 'POST', `/threads/${id}/replies`, { body: { body: `匿名回帖 ${Date.now().toString(36)}` } });
  assert.equal(anon.status, 201, `匿名回帖应 201，实际 ${anon.status}`);
  assert.equal(anon.json?.post?.author, '匿名用户', '匿名回帖作者应为匿名用户');

  const forged = await apiFetch(srv.base, 'POST', `/threads/${id}/replies`, {
    token: 'forged-token-abc',
    body: { body: '伪造 token 回帖' },
  });
  assert.equal(forged.status, 401, `无效 Bearer 回帖应 401，实际 ${forged.status}`);
  assert.equal(forged.json?.error, 'invalid_token', `错误码应为 invalid_token，实际 ${forged.json?.error}`);

  const empty = await apiFetch(srv.base, 'POST', `/threads/${id}/replies`, { token: seed.token, body: { body: '' } });
  assert.equal(empty.status, 400, `空回帖应 400，实际 ${empty.status}`);

  const missing = await apiFetch(srv.base, 'POST', '/threads/999999/replies', {
    token: seed.token,
    body: { body: '不存在的主题回帖' },
  });
  assert.equal(missing.status, 404, `未知主题回帖应 404，实际 ${missing.status}`);
});

test('搜索：可命中标题/正文/回帖，无结果返回空数组', async () => {
  requireBoot();
  const hitTitle = await apiFetch(srv.base, 'GET', `/search?q=${encodeURIComponent(seed.markers.alpha.slice(0, 12))}`);
  assert.equal(hitTitle.status, 200);
  assert.ok(Array.isArray(hitTitle.json?.threads) || Array.isArray(hitTitle.json?.results), '搜索应返回数组');

  const hitBody = await apiFetch(srv.base, 'GET', `/search?q=${encodeURIComponent(seed.markers.beta)}`);
  const threadsB = hitBody.json?.threads || hitBody.json?.results || [];
  assert.ok(threadsB.length >= 1, '搜索应命中正文 marker');

  const hitReply = await apiFetch(srv.base, 'GET', `/search?q=${encodeURIComponent(seed.markers.reply)}`);
  const threadsR = hitReply.json?.threads || hitReply.json?.results || [];
  assert.ok(threadsR.length >= 1, '搜索应命中回帖 marker');

  const none = await apiFetch(srv.base, 'GET', '/search?q=' + encodeURIComponent('zzz-no-such-token-qa-zzz'));
  assert.equal(none.status, 200);
  const emptyList = none.json?.threads || none.json?.results || [];
  assert.equal(emptyList.length, 0, '无结果搜索应为空数组');
});

test('CORS：跨域前端（GitHub Pages/Cloudflare Pages）可调用 API', async () => {
  requireBoot();
  const origin = 'http://127.0.0.1:4422';
  const pre = await apiFetch(srv.base, 'OPTIONS', '/threads', {
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.ok([200, 204].includes(pre.status), `OPTIONS 预检应 200/204，实际 ${pre.status}`);
  const allowOrigin = pre.headers.get('access-control-allow-origin');
  assert.ok(allowOrigin, '预检响应缺少 Access-Control-Allow-Origin');
  assert.ok(
    allowOrigin === '*' || allowOrigin === origin,
    `Access-Control-Allow-Origin 应允许前端域，实际 ${allowOrigin}`,
  );
  const allowHeaders = (pre.headers.get('access-control-allow-headers') || '').toLowerCase();
  assert.match(allowHeaders, /authorization/, `预检应允许 Authorization 头，实际 ${allowHeaders}`);
  const allowMethods = (pre.headers.get('access-control-allow-methods') || '').toUpperCase();
  assert.match(allowMethods, /POST/, `预检应允许 POST，实际 ${allowMethods}`);

  const actual = await apiFetch(srv.base, 'GET', '/categories', { headers: { origin } });
  assert.ok(actual.headers.get('access-control-allow-origin'), '实际 GET 响应应带 CORS 头');
});

test('未知 API 返回 404 JSON（非 HTML）', async () => {
  requireBoot();
  const res = await apiFetch(srv.base, 'GET', '/api/v1/definitely-not-exists');
  assert.equal(res.status, 404);
  assert.match(res.contentType, /application\/json/i, `未知 API 应返回 JSON，实际 ${res.contentType}`);
  assert.ok(res.json?.error, '404 JSON 应含 error');
});

/* ------------------------------------------------------------------ */
/* 自建板块（2026-10-22 新需求）                                        */
/* ------------------------------------------------------------------ */

function makeCat(size = 4) {
  const s = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { name: `自建板块${s}`.slice(0, 20), description: `QA 自建板块简介 ${s}`.slice(0, 120), slug: null };
}

test('初始板块名称已更新：jailbreak=越狱实战、vuln=模型漏洞（VULN）', async () => {
  requireBoot();
  const res = await apiFetch(srv.base, 'GET', '/api/v1/categories');
  const bySlug = Object.fromEntries((res.json?.categories || []).map((c) => [c.slug, c]));
  assert.equal(bySlug.jailbreak?.name, '越狱实战', `jailbreak 名称应为越狱实战，实际 ${bySlug.jailbreak?.name}`);
  assert.equal(bySlug.vuln?.name, '模型漏洞', `vuln 名称应为模型漏洞，实际 ${bySlug.vuln?.name}`);
  assert.equal((bySlug.vuln?.latin || '').toUpperCase(), 'VULN', 'vuln latin 应为 VULN');
  assert.ok(!/研究|报告|披露/.test(bySlug.jailbreak?.description || ''), `jailbreak 简介应为进攻方口吻，实际 ${bySlug.jailbreak?.description}`);
});

test('POST /categories：未登录 401；名称过短 400；简介超长 400', async () => {
  requireBoot();
  const c = makeCat();
  const anon = await apiFetch(srv.base, 'POST', '/categories', {
    body: { name: c.name, description: c.description },
  });
  assert.equal(anon.status, 401, `未登录建板块应 401，实际 ${anon.status}`);

  const token = catTokens[0];
  const shortName = await apiFetch(srv.base, 'POST', '/categories', { token, body: { name: '短', description: '' } });
  assert.equal(shortName.status, 400, `名称过短应 400，实际 ${shortName.status}`);
  const longDesc = await apiFetch(srv.base, 'POST', '/categories', {
    token,
    body: { name: '合法的板块名称', description: 'x'.repeat(130) },
  });
  assert.equal(longDesc.status, 400, `简介超过 120 字（130）应 400，实际 ${longDesc.status}`);
});

test('POST /categories：创建 201 + redirect /c/<slug>/ + 出现在 categories 与 site 快照', async () => {
  requireBoot();
  const token = catTokens[0];
  const c = makeCat();
  const res = await apiFetch(srv.base, 'POST', '/categories', {
    token,
    body: { name: c.name, description: c.description },
  });
  assert.equal(res.status, 201, `建板块应 201，实际 ${res.status} ${res.text.slice(0, 300)}`);
  const category = res.json?.category;
  assert.ok(category?.slug, '返回应含 category.slug');
  assert.equal(category.name, c.name);
  assert.equal(res.json?.redirect, `/c/${category.slug}/`, `redirect 应为 /c/<slug>/，实际 ${res.json?.redirect}`);
  assert.match(category.slug, /^[a-z0-9-]+$/, `slug 应为安全字符，实际 ${category.slug}`);

  const list = await apiFetch(srv.base, 'GET', '/api/v1/categories');
  const found = (list.json?.categories || []).find((x) => x.slug === category.slug);
  assert.ok(found, '新板块应出现在 GET /categories');
  assert.equal(found.name, c.name);

  const site = await apiFetch(srv.base, 'GET', '/api/v1/site');
  assert.ok(
    (site.json?.categories || []).some((x) => x.slug === category.slug),
    '新板块应出现在 /api/v1/site 快照（SSG 构建数据源）',
  );

  // 同名重复 → 409
  const dup = await apiFetch(srv.base, 'POST', '/categories', {
    token,
    body: { name: c.name, description: c.description },
  });
  assert.equal(dup.status, 409, `同名板块应 409，实际 ${dup.status}`);
});

test('自建板块可用于分类列表过滤与发帖（新板块功能闭环）', async () => {
  requireBoot();
  const token = catTokens[1];
  const c = makeCat();
  const created = await apiFetch(srv.base, 'POST', '/categories', {
    token,
    body: { name: c.name, description: c.description },
  });
  assert.equal(created.status, 201);
  const slug = created.json.category.slug;

  const list = await apiFetch(srv.base, 'GET', `/api/v1/threads?category=${encodeURIComponent(slug)}`);
  assert.equal(list.status, 200, `自建板块应能用于分类过滤（期望 200，实际 ${list.status}）`);

  const post = await createThreadApi(srv.base, token, {
    category: slug,
    title: `自建板块首个主题 ${Date.now().toString(36)}`,
    body: '这是发到自建板块的正文，验证新板块可正常发帖。',
    verification: 'none',
  });
  assert.equal(post.status, 201, '自建板块应能发帖');
  assert.equal(post.json?.thread?.category, slug, '帖子应归属自建板块');
});

test('自建板块限流：同一用户 1 小时内第 6 次创建返回 429', async () => {
  requireBoot();
  const token = catTokens[1]; // 该用户此前已在「功能闭环」测试创建过 1 个板块
  const results = [];
  for (let i = 0; i < 4; i++) {
    const res = await apiFetch(srv.base, 'POST', '/categories', {
      token,
      body: { name: `限流板块${i}${Date.now().toString(36).slice(-4)}`, description: '' },
    });
    results.push(res.status);
  }
  assert.deepEqual(results, [201, 201, 201, 201], `前 4 次应成功（累计 5 个），实际 ${JSON.stringify(results)}`);
  const sixth = await apiFetch(srv.base, 'POST', '/categories', {
    token,
    body: { name: `限流板块X${Date.now().toString(36).slice(-4)}`, description: '' },
  });
  assert.equal(sixth.status, 429, `第 6 次创建应 429，实际 ${sixth.status}`);
});

test('匿名发帖按 IP 限流（10/小时）：达到上限返回 429', async () => {
  requireBoot();
  const catSlug = seed.threads[0].category || 'jailbreak';
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const res = await apiFetch(srv.base, 'POST', '/threads', {
      body: {
        category: catSlug,
        title: `匿名限流验收 ${i}-${Date.now().toString(36)}`,
        body: '匿名限流测试正文，长度足够用于校验。',
        verification: 'none',
      },
    });
    statuses.push(res.status);
    if (res.status === 429) break;
  }
  const successes = statuses.filter((s) => s === 201).length;
  assert.equal(statuses.at(-1), 429, `匿名发帖达到 10/小时应返回 429，实际序列 ${JSON.stringify(statuses)}`);
  assert.ok(successes >= 8 && successes <= 10, `匿名发帖成功次数应接近上限 10（含此前测试的匿名帖），实际 ${successes}: ${JSON.stringify(statuses)}`);
});
