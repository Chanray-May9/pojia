// tests/deploy-config.test.mjs — E(可静态验证部分). Cloudflare 部署配置静态检查（不做真实部署）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const P = (rel) => path.join(ROOT, rel);
const readIf = (rel) => (existsSync(P(rel)) ? readFileSync(P(rel), 'utf8') : null);

test('关键目录/文件存在：backend、frontend、shared、deploy', async () => {
  for (const rel of [
    'ARCHITECTURE.md',
    'backend/worker.mjs',
    'backend/app.mjs',
    'backend/db.mjs',
    'backend/local-db.mjs',
    'backend/local-server.mjs',
    'backend/auth.mjs',
    'backend/schema.sql',
    'frontend/build.mjs',
    'frontend/public/app.css',
    'shared/models.mjs',
    'shared/markdown.mjs',
  ]) {
    assert.ok(existsSync(P(rel)), `缺少 ${rel}`);
  }
  // 渐进增强脚本允许位于 frontend/client/ 或 frontend/public/（构建会复制到 dist/assets）
  const appJs = ['frontend/client/app.js', 'frontend/public/app.js'].find((r) => existsSync(P(r)));
  assert.ok(appJs, '缺少前端渐进增强脚本（frontend/client/app.js 或 frontend/public/app.js）');
});

test('wrangler.toml 绑定 Worker 与 D1，且未提交真实密钥', async () => {
  const candidates = ['deploy/wrangler.toml', 'wrangler.toml'];
  const found = candidates.find((r) => existsSync(P(r)));
  assert.ok(found, '缺少 wrangler.toml（deploy/wrangler.toml 或根目录）');
  const toml = readIf(found);
  assert.match(toml, /^name\s*=\s*"[^"]+"/m, 'wrangler 应配置 worker name');
  const main = toml.match(/^main\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(main, 'wrangler 应配置 main 入口');
  assert.match(toml, /\[\[d1_databases\]\]/, 'wrangler 应配置 [[d1_databases]]');
  assert.match(toml, /binding\s*=\s*"DB"/, 'D1 绑定名应为 DB');
  assert.match(toml, /database_name\s*=\s*"/, '应配置 database_name');
  assert.match(toml, /compatibility_date\s*=\s*"/, '应配置 compatibility_date');
  // 密钥不得硬编码（APP_SECRET 应通过 wrangler secret put 注入）
  assert.ok(!/APP_SECRET\s*=\s*"(?!.*YOUR)[^"]{12,}"/.test(toml), '不应在 wrangler.toml 硬编码 APP_SECRET 实际值');
  const placeholders = /YOUR_|REPLACE_|xxx|example\.com/i.test(toml);
  assert.ok(placeholders || /database_id\s*=\s*"/.test(toml), 'D1 database_id/域名应留占位或已配置');

  // main 指向的 Worker 文件应真实存在（相对 wrangler.toml 所在目录解析）
  const mainPath = path.resolve(path.dirname(P(found)), main);
  assert.ok(existsSync(mainPath), `wrangler main 指向的文件不存在: ${main} -> ${mainPath}`);
  assert.match(main, /worker\.mjs$/, `main 应指向 backend/worker.mjs，实际 ${main}`);

  // D1 migrations 目录应存在且至少包含一个 .sql
  const migrationsDir = toml.match(/migrations_dir\s*=\s*"([^"]+)"/)?.[1] || 'migrations';
  const migPath = path.resolve(path.dirname(P(found)), migrationsDir);
  assert.ok(existsSync(migPath), `D1 migrations_dir 不存在: ${migrationsDir} -> ${migPath}`);
  const sqls = readdirSync(migPath).filter((f) => f.endsWith('.sql'));
  assert.ok(sqls.length >= 1, `D1 migrations 目录应至少有一个 .sql，实际 ${sqls.length}`);
});

test('D1 migrations 与 backend/schema.sql 表结构一致（同一份 DDL）', async () => {
  const candidates = ['deploy/wrangler.toml', 'wrangler.toml'];
  const found = candidates.find((r) => existsSync(P(r)));
  assert.ok(found, '缺少 wrangler.toml');
  const toml = readIf(found);
  const migrationsDir = toml.match(/migrations_dir\s*=\s*"([^"]+)"/)?.[1] || 'migrations';
  const migPath = path.resolve(path.dirname(P(found)), migrationsDir);
  const init = readdirSync(migPath).filter((f) => f.endsWith('.sql')).sort()[0];
  assert.ok(init, '缺少 D1 migration 文件');
  const migSql = readFileSync(path.join(migPath, init), 'utf8');
  const schemaSql = readIf('backend/schema.sql');

  const tables = (sql) => new Set([...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1].toLowerCase()));
  const migTables = tables(migSql);
  const schemaTables = tables(schemaSql);
  for (const t of schemaTables) {
    assert.ok(migTables.has(t), `migration ${init} 缺少 schema.sql 中的表 ${t}`);
  }
  for (const col of ['password_hash', 'token_hash', 'role', 'verification', 'model_custom', 'models']) {
    assert.match(migSql, new RegExp(`\\b${col}\\b`, 'i'), `migration ${init} 缺少字段 ${col}`);
  }
});

test('GitHub Actions 发布 Pages：构建命令使用 SITE_URL/API_BASE 环境变量', async () => {
  const candidates = ['.github/workflows/pages.yml', 'deploy/github-pages.yml'];
  const found = candidates.find((r) => existsSync(P(r)));
  assert.ok(found, '缺少 GitHub Pages workflow（.github/workflows/pages.yml 或 deploy/github-pages.yml）');
  const yml = readIf(found);
  assert.match(yml, /pages:\s*write|contents:\s*read/, 'workflow 应声明 Pages 权限');
  assert.match(yml, /frontend\/build\.mjs/, 'workflow 应调用 frontend/build.mjs');
  assert.match(yml, /SITE_URL/, 'workflow 构建应传入 SITE_URL');
  assert.match(yml, /API_BASE/, 'workflow 构建应传入 API_BASE');
  assert.match(yml, /upload-pages-artifact|actions\/deploy-pages/, 'workflow 应使用官方 Pages 部署 action');
});

test('D1 schema 含 v2 必需表与字段（用户角色、会话摘要、模型/验证标注）', async () => {
  const sql = readIf('backend/schema.sql');
  assert.ok(sql, '缺少 backend/schema.sql');
  for (const table of ['users', 'sessions', 'categories', 'threads', 'posts']) {
    assert.match(sql, new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`, 'i'), `schema 应包含 ${table} 表`);
  }
  assert.match(sql, /role\s+TEXT/i, 'users 表应有 role 列（管理员复核）');
  assert.match(sql, /token_hash\s+TEXT/i, 'sessions 表应存 token_hash（SHA-256 摘要）');
  assert.match(sql, /verification\s+TEXT/i, 'threads 表应有 verification 列');
  assert.match(sql, /model_custom\s+TEXT/i, 'threads 表应有 model_custom 列');
  assert.match(sql, /models\s+TEXT/i, 'threads 表应有 models 列');
  assert.match(sql, /password_hash\s+TEXT/i, 'users 表应有 password_hash 列');
});

test('shared/models.mjs 模型目录：id 唯一、含 label/vendor、覆盖契约模型集合', async () => {
  const mod = await import(`file://${P('shared/models.mjs').replace(/\\/g, '/')}`);
  const list = mod.MODELS || mod.models || mod.default;
  assert.ok(Array.isArray(list), 'shared/models.mjs 应导出模型数组');
  assert.ok(list.length >= 12, `模型目录过少: ${list.length}`);
  const ids = list.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, '模型 id 应唯一');
  for (const m of list) {
    assert.ok(m.id && typeof m.id === 'string', `模型缺少 id: ${JSON.stringify(m)}`);
    assert.ok(m.label && typeof m.label === 'string', `模型 ${m.id} 缺少 label`);
  }
  const expected = ['gpt', 'claude', 'gemini', 'llama', 'qwen', 'deepseek', 'mistral', 'glm', 'kimi', 'doubao', 'ernie', 'other'];
  for (const id of expected) {
    assert.ok(ids.includes(id), `模型目录应包含契约模型 ${id}，实际 ${ids.join(',')}`);
  }
});

test('仓库内无明文云凭据/私钥（线上安全前置检查）', async () => {
  const skipDirs = new Set(['_qa', 'data', 'node_modules', '.git', 'tests']);
  const patterns = [
    { name: '私钥', re: /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
    { name: 'GitHub Token', re: /ghp_[A-Za-z0-9]{36}/ },
    { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'OpenAI Key', re: /sk-[A-Za-z0-9]{32,}/ },
  ];
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skipDirs.has(name)) continue;
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.size < 512 * 1024 && /\.(mjs|js|json|toml|yml|yaml|md|sql|css|html|txt)$/i.test(name)) {
        const content = readFileSync(full, 'utf8');
        for (const p of patterns) {
          if (p.re.test(content)) hits.push({ file: path.relative(ROOT, full), kind: p.name });
        }
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, [], `发现疑似明文凭据: ${JSON.stringify(hits)}`);
});

test('线上不可验证项已文档化（wrangler/D1/自定义域名只能静态检查）', async () => {
  const doc = readIf('ARCHITECTURE.md');
  assert.ok(doc, '缺少 ARCHITECTURE.md');
  for (const kw of ['wrangler', 'D1', 'Cloudflare', 'GitHub Pages', 'SITE_URL', 'API_BASE']) {
    assert.match(doc, new RegExp(kw, 'i'), `ARCHITECTURE.md 应说明 ${kw}`);
  }
});

test('D1 migration 的板块种子与 shared/categories.mjs 同步（名称/文案已更新）', async () => {
  const mod = await import(`file://${P('shared/categories.mjs').replace(/\\/g, '/')}`);
  const categories = mod.CATEGORIES || mod.default;
  assert.ok(Array.isArray(categories) && categories.length >= 7);

  const candidates = ['deploy/wrangler.toml', 'wrangler.toml'];
  const found = candidates.find((r) => existsSync(P(r)));
  assert.ok(found, '缺少 wrangler.toml');
  const toml = readIf(found);
  const migrationsDir = toml.match(/migrations_dir\s*=\s*"([^"]+)"/)?.[1] || 'migrations';
  const migDir = path.resolve(path.dirname(P(found)), migrationsDir);
  const sql = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(path.join(migDir, f), 'utf8'))
    .join('\n');

  for (const c of categories) {
    assert.match(sql, new RegExp(`'${c.slug}'`, 'i'), `migration 缺少板块 slug ${c.slug}`);
    assert.ok(sql.includes(c.name), `migration 缺少/未同步板块名称「${c.name}」（shared/categories.mjs 已改名）`);
  }
  for (const oldName of ['越狱研究', '模型漏洞报告', 'DISCLOSURE']) {
    assert.ok(!sql.includes(oldName), `migration 仍包含旧板块名/标识「${oldName}」`);
  }
  assert.ok(!/负责任披露|免责声明|未经授权禁止/.test(sql), 'migration 板块文案不应再包含免责/合规措辞');
});

test('guest 匿名用户 migration 存在且不可登录（role=guest / 密码哈希占位符）', async () => {
  const candidates = ['deploy/wrangler.toml', 'wrangler.toml'];
  const found = candidates.find((r) => existsSync(P(r)));
  assert.ok(found, '缺少 wrangler.toml');
  const toml = readIf(found);
  const migrationsDir = toml.match(/migrations_dir\s*=\s*"([^"]+)"/)?.[1] || 'migrations';
  const migDir = path.resolve(path.dirname(P(found)), migrationsDir);
  const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 2, `migrations 应至少包含 0001/0002，实际 ${JSON.stringify(files)}`);
  const guestFile = files.find((f) => /guest/i.test(f));
  assert.ok(guestFile, `应存在 guest 匿名用户 migration，实际 ${JSON.stringify(files)}`);
  const sql = readFileSync(path.join(migDir, guestFile), 'utf8');
  assert.match(sql, /INSERT INTO users/i, 'guest migration 应写入 users');
  assert.match(sql, /'匿名用户'/, 'guest migration 应创建「匿名用户」');
  assert.match(sql, /'guest'/, "guest migration 应设置 role='guest'");
  assert.match(sql, /'!'/, 'guest 密码哈希应为不可登录占位符');
});
