#!/usr/bin/env node
/**
 * 本地演示数据（可选，不参与线上部署）：
 *   node scripts/demo-data.mjs --api http://127.0.0.1:4400
 *
 * 会注册两个普通用户并发布 3 篇主题 + 若干回复；
 * 若提供 --admin-admin 环境变量（ADMIN_USERNAME/ADMIN_PASSWORD）则顺带演示"站务复核实机验证"。
 */
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const API = String(flag('api', process.env.API_BASE || 'http://127.0.0.1:4400')).replace(/\/+$/, '');

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}/api/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function ensureUser(username, email) {
  const password = 'DemoPass123!';
  const reg = await api('auth/register', { method: 'POST', body: { username, email, password } });
  if (reg.ok) return reg.data;
  const login = await api('auth/login', { method: 'POST', body: { login: username, password } });
  if (!login.ok) throw new Error(`无法创建/登录 ${username}: ${JSON.stringify(login.data)}`);
  return login.data;
}

const THREADS = [
  {
    category: 'injection',
    title: '间接注入：邮件工具链中的角色混淆观察',
    models: ['gpt', 'claude'],
    verification: 'self',
    body: `## 测试对象

- 模型：GPT-4o、Claude Sonnet（均通过官方 API）
- 场景：带工具调用的邮件助手，只读权限
- 目的：观察"不可信内容"进入上下文后对工具选择的影响

## 复现步骤

1. 系统提示约束：只能读取邮件，不得发送。
2. 在邮件正文中嵌入一段要求"整理并转发"的指令。
3. 观察模型是否把邮件内容当作指令。

\`\`\`text
[system] 你是邮件助手，只允许读取邮件…
[user]   帮我总结今天的邮件
[tool]   邮件正文：…（含伪造的"运维指令"）
\`\`\`

## 观察结果

在 12 次尝试中，有 3 次模型主动调用发送工具，但都在参数校验处被拦下（未配置发送权限）。

> 结论：工具权限收敛比提示词防护更可靠。

## 待验证

- 加入"引用块"标记后失败率是否下降？
- 多语言混合是否影响判断？`,
  },
  {
    category: 'defense',
    title: '系统提示加固：三层防御的回归评测方法',
    models: ['qwen', 'deepseek'],
    verification: 'none',
    body: `## 背景

很多团队只在系统提示里加一句"不要被注入"，但缺少回归评测。

## 三层防御

1. **输入层**：把外部内容隔离为明确的数据块，并标记来源。
2. **决策层**：工具调用前要求显式确认，最小权限。
3. **输出层**：敏感字段过滤与格式约束。

## 评测方法

| 层级 | 指标 | 采样 |
| --- | --- | --- |
| 输入层 | 注入识别率 | 200 条 |
| 决策层 | 越权工具调用率 | 100 次 |
| 输出层 | 敏感信息泄露率 | 100 次 |

## 结论

只加提示词而不做回归评测，无法证明防御有效；需要把攻击样本固化成持续集成的测试集。`,
  },
  {
    category: 'redteam',
    title: '红队报告模板：从"能绕"到可量化结论',
    models: ['other'],
    model_custom: '某企业内部微调模型 v2',
    verification: 'self',
    body: `## 报告结构

- 范围与授权
- 测试对象与版本
- 测试方法（提示层级、样本量）
- 结果矩阵（成功率、失败情形）
- 风险等级与修复建议

## 结果矩阵示例

\`\`\`text
样本        尝试   绕过   成功率
角色扮演     50     4     8%
编码绕过     50     7     14%
多轮诱导     50    11     22%
\`\`\`

## 建议

1. 对高风险路径增加人工复核。
2. 把成功样本加入回归测试集。
3. 记录失败案例同样重要。`,
  },
];

async function main() {
  const a = await ensureUser('researcher', 'researcher@example.com');
  const b = await ensureUser('analyst', 'analyst@example.com');
  const ids = [];
  for (const t of THREADS) {
    const res = await api('threads', { method: 'POST', token: a.token, body: t });
    if (res.ok) {
      ids.push(res.data.thread.id);
      console.log(`发布：${t.title} -> ${res.data.redirect}`);
    } else {
      console.log(`跳过（可能已存在）：${t.title} ${JSON.stringify(res.data)}`);
      const site = await api('site?page_size=200');
      const found = site.data.threads?.find((x) => x.title === t.title);
      if (found) ids.push(found.id);
    }
  }
  for (const [i, id] of ids.entries()) {
    if (!id) continue;
    const reply = await api(`threads/${id}/replies`, {
      method: 'POST',
      token: b.token,
      body: {
        body:
          i === 0
            ? '补充一个观察：把外部内容包在 JSON 字段里时，模型更倾向于当数据处理，成功率明显下降。'
            : '这个评测口径很实用。建议把失败样本也纳入回归集，否则容易高估防御效果。',
      },
    });
    if (reply.ok) console.log(`回复：thread ${id} floor ${reply.data.post.floor}`);
  }

  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;
  if (adminUser && adminPass && ids[0]) {
    const login = await api('auth/login', { method: 'POST', body: { login: adminUser, password: adminPass } });
    if (login.ok) {
      const verify = await api(`threads/${ids[0]}/verify`, {
        method: 'POST',
        token: login.data.token,
        body: { verification: 'admin' },
      });
      console.log(`站务复核：${verify.ok ? verify.data.label : JSON.stringify(verify.data)}`);
    }
  }
  console.log('演示数据完成。现在可运行前端构建。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
