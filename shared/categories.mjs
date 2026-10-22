/**
 * 破甲论坛 · 前后端共用常量
 * 注意：该文件会被 Worker（Cloudflare）与构建脚本共同引用，禁止 node:* 导入。
 */

export const CATEGORIES = [
  {
    slug: 'jailbreak',
    name: '越狱实战',
    latin: 'JAILBREAK',
    description:
      '角色扮演、多轮诱导、编码绕过、上下文挤压——只发真打实测、能复现的越狱路径。',
  },
  {
    slug: 'injection',
    name: '提示词注入',
    latin: 'INJECTION',
    description: '直接注入、间接注入、工具投毒与 Agent 上下文劫持的攻击链路复盘。',
  },
  {
    slug: 'redteam',
    name: '红队评估',
    latin: 'RED TEAM',
    description: '评估方案、用例库、评分口径与报告模板：把"能绕"变成可交付的结论。',
  },
  {
    slug: 'defense',
    name: '防御与对齐',
    latin: 'DEFENSE',
    description: '拒绝策略、系统提示加固、输出过滤与评测回归——看清对方的甲补在哪。',
  },
  {
    slug: 'tooling',
    name: '工具与资源',
    latin: 'TOOLING',
    description: '攻击框架、自动化 harness、数据集、论文与现成利用链。',
  },
  {
    slug: 'vuln',
    name: '模型漏洞',
    latin: 'VULN',
    description: '模型与 Agent 的漏洞发现、复现条件、影响面与披露节奏。',
  },
  {
    slug: 'general',
    name: '综合讨论',
    latin: 'GENERAL',
    description: '行业观察、边界讨论、社区事务与新人提问。',
  },
];

export const CATEGORY_MAP = new Map(CATEGORIES.map((c, i) => [c.slug, { ...c, order: i + 1 }]));

export const VERIFICATION_STATES = ['none', 'self', 'admin'];

export const VERIFICATION_LABELS = {
  none: '未标注实机验证',
  self: '实机验证 · 作者自述',
  admin: '实机验证 · 已复核',
};
