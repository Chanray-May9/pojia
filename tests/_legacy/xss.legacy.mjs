// tests/xss.test.mjs — 验收项 7：XSS 输出转义（帖子/回帖/搜索反射/JSON-LD 注入）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer,
  Client,
  makeCtx,
  registerViaContract,
  loginViaContract,
  createPostViaContract,
  replyViaContract,
  parseLdJson,
  textOf,
} from './helpers.mjs';

const PORT = 4314;
let srv;
let client;
let ctx;
let post;
let bootError = null;

before(async () => {
  try {
    srv = await startServer({ port: PORT, dbFile: 'test-xss.db' });
    client = new Client(srv.base);
    ctx = makeCtx('xss', {
      title: `XSS验收帖 ${Date.now().toString(36)}`,
      body: [
        '正文开始。',
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(2)>',
        '<svg onload=alert(3)></svg>',
        '</script><script>alert(4)</script>',
        '" onmouseover="alert(5)',
        '正文结束 marker xss-body.',
      ].join('\n'),
    });
    await registerViaContract(client, ctx);
    await loginViaContract(client, ctx);
    post = await createPostViaContract(client, ctx);
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

const RAW_DANGEROUS = [
  { name: '内联 script', re: /<script[^>]*>\s*alert\s*\(/i },
  { name: 'img onerror', re: /<img[^>]+onerror\s*=/i },
  { name: 'svg onload', re: /<svg[^>]+onload\s*=/i },
  { name: '属性逃逸 onmouseover', re: /<[a-z][^>]+onmouseover\s*=\s*"alert/i },
  { name: 'script 断链注入', re: /<\/script\s*>\s*<script[^>]*>\s*alert/i },
];

test('帖子正文中的 XSS payload 在帖子页被转义，不产生可执行标签', async () => {
  requireBoot();
  const res = await client.get(post.postPath);
  assert.equal(res.status, 200);
  for (const { name, re } of RAW_DANGEROUS) {
    assert.ok(!re.test(res.html), `帖子页出现未转义 XSS（${name}）`);
  }
  // 转义证据：&lt;script&gt; 形式出现（或内容被安全移除）
  assert.match(res.html, /&lt;script/i, '帖子页应出现转义后的 &lt;script');
  assert.match(res.html, /&lt;img|&lt;svg/i, '帖子页应出现转义后的 &lt;img / &lt;svg');
  // 纯文本中不应出现可执行片段
  const text = textOf(res.html);
  assert.ok(!text.includes('<script>alert(1)</script>'), '页面文本不应还原出脚本标签');
});

test('帖子标题中的特殊字符在 <title>/h1 中安全输出', async () => {
  requireBoot();
  const res = await client.get(post.postPath);
  for (const { name, re } of RAW_DANGEROUS) {
    assert.ok(!re.test(res.html), `标题/页面出现未转义 XSS（${name}）`);
  }
  const title = res.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  assert.ok(!title.includes('<script'), '<title> 内不应有原始 script 标签');
  const h1 = res.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '';
  assert.ok(!h1.includes('<script'), '<h1> 内不应有原始 script 标签');
});

test('回帖内容中的 XSS payload 被转义', async () => {
  requireBoot();
  const replyText = '回帖 XSS <script>alert(6)</script> <img src=x onerror=alert(7)> marker xss-reply';
  const reply = await replyViaContract(client, post.postPath, replyText, ctx);
  assert.equal(reply.res.status, 303);
  const res = await client.get(post.postPath);
  for (const { name, re } of RAW_DANGEROUS) {
    assert.ok(!re.test(res.html), `回帖渲染出现未转义 XSS（${name}）`);
  }
  assert.match(res.html, /&lt;script/i, '回帖应出现转义后的 &lt;script');
});

test('搜索页反射查询参数被转义', async () => {
  requireBoot();
  const payload = '<script>alert(8)</script>';
  const res = await client.get(`/search?q=${encodeURIComponent(payload)}`);
  assert.equal(res.status, 200);
  assert.ok(!/<script[^>]*>\s*alert\s*\(8\)/i.test(res.html), '搜索页反射出现未转义 script');
  assert.ok(!/<img[^>]+onerror/i.test(res.html), '搜索页反射出现未转义 onerror');
  assert.match(res.html, /&lt;script/i, '搜索页应转义并显示查询词');
});

test('JSON-LD 中不因帖子内容含 </script> 而破损（所有 JSON-LD 仍可 parse）', async () => {
  requireBoot();
  const res = await client.get(post.postPath);
  const parsed = parseLdJson(res.html);
  assert.deepEqual(parsed.errors, [], `JSON-LD 被内容注入破坏: ${JSON.stringify(parsed.errors)}`);
  assert.ok(parsed.blocks.length > 0, '帖子页应有 JSON-LD');
  const dump = JSON.stringify(parsed.blocks);
  assert.ok(!/<\/script/i.test(dump), 'JSON-LD 内不应出现未转义的 </script 序列');
});
