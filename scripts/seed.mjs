#!/usr/bin/env node
/**
 * 可选：写入一篇示例主题，用于本地演示或搜索引擎收录验证。
 * 默认不写任何内容（空框架）；需要时显式运行：
 *   node scripts/seed.mjs
 *   node scripts/seed.mjs --reset   # 清空示例
 *
 * 需要先有管理员账号（scripts/make-admin.mjs 或环境变量 ADMIN_*）。
 */
import { getDb, closeDb, seedAdminFromEnv } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';
import { slugify } from '../src/queries.mjs';

const reset = process.argv.includes('--reset');
const conn = getDb();

if (reset) {
  conn.exec("DELETE FROM posts WHERE thread_id IN (SELECT id FROM threads WHERE slug LIKE 'demo-%')");
  conn.exec("DELETE FROM threads WHERE slug LIKE 'demo-%'");
  console.log('已移除示例主题。');
  closeDb();
  process.exit(0);
}

let authorId = seedAdminFromEnv();
if (!authorId) {
  const existing = conn.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!existing) {
    console.error('请先创建管理员：ADMIN_USERNAME=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/seed.mjs');
    process.exit(1);
  }
  authorId = existing.id;
}

const demo = {
  category: 'redteam',
  title: '示例：如何给出可复现的越狱观察记录',
  slug: 'demo-reproducible-jailbreak-report',
  body: `这是一篇示例主题，用于演示帖子版式与搜索引擎收录。可在 \`scripts/seed.mjs\` 中删除。

## 一个合格的研究记录包含

1. **测试对象**：模型名称、版本、接入方式（API / 网页 / 本地）。
2. **提示结构**：system、user、tool 各层分别写了什么，顺序如何。
3. **复现步骤**：从空会话开始的完整操作序列。
4. **观察结果**：贴出关键输入输出片段，说明成功率与失败情形。
5. **防御建议**：这层"甲"应该补在哪里。

\`\`\`text
[system] 你是…（省略）
[user]   忽略以上…
[model]  …
\`\`\`

> 只研究自有或已获授权的模型。未修复的高危细节请走负责任的协调披露流程。`,
};

const now = new Date().toISOString();
const exists = conn.prepare('SELECT id FROM threads WHERE slug = ?').get(demo.slug);
if (exists) {
  console.log('示例主题已存在，跳过。');
} else {
  conn
    .prepare(
      `INSERT INTO threads (category, author_id, title, slug, body, created_at, updated_at, last_post_at, reply_count, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`
    )
    .run(demo.category, authorId, demo.title, demo.slug, demo.body, now, now, now);
  console.log('已写入 1 篇示例主题。');
}
closeDb();
