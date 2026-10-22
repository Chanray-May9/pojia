# 破甲论坛 · 网络调研报告

> 调研范围：① 部署/工程类教程与官方文档；② AI 越狱/提示词攻防的**安全研究类**学习资料（不含可操作越狱教程）。
> 调研时间：2026-10-22（所有"最新版本/额度"结论以该日期为准，平台额度会变，落地前请复核）。
> 调研方法：`web_search` 定位 + `web_fetch` 逐条打开验证 HTTP 状态与正文标题。

**验证标记说明**

| 标记 | 含义 |
| --- | --- |
| ✅ 已抓取 | `web_fetch` 返回 200，且页面标题/正文与所述一致 |
| 🟡 仅搜索可见 | 搜索引擎结果中出现该 URL 且标题匹配，但直连抓取失败（多为反爬/网络限制） |
| ❌ 不可访问 | 本次调研中抓取失败，已注明失败原因 |
| 🔶 需注意 | 内容可访问，但有版本时效、维护状态或合规风险需要标注 |

---

## 第一章 大佬教程（部署/工程类）

### 1.1 Cloudflare Workers + D1：入门与最佳实践

#### 1. D1 官方总览（文档入口）
- **URL**：https://developers.cloudflare.com/d1/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Apr 30, 2026）
- **一句话价值**：D1 的能力边界地图——SQLite 语义、Time Travel（时间点恢复）、读复制（Beta）、Worker/HTTP 双入口，一页看清"这东西能干什么、不能干什么"。
- **适用性备注**：Free 与 Paid 均可用；文中明确"按查询与存储计费，不为闲置实例计费"。适合作为论坛置顶的"官方索引页"。

#### 2. D1 快速上手（建库 → 绑 Worker → 本地跑 → 部署）
- **URL**：https://developers.cloudflare.com/d1/get-started/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Aug 25, 2026）
- **一句话价值**：20 分钟打通"`wrangler d1 create` → 写 `d1_databases` 绑定 → `wrangler d1 execute --local` → `wrangler dev`（localhost:8787）→ `wrangler deploy`"。
- **适用性备注**：
  - 官方示例里**特意演示了 `prepare().bind()` 防 SQL 注入**，这点值得在论坛强调——社区站最容易被注入的就是这类手写 SQL。
  - `--local` 与 `--remote` 必须各跑一次建表脚本，新手最常踩的坑就是"本地有表、线上 500"。
  - 文中当前 Wrangler 版本示例为 4.x（`wrangler 4.33.x`），写教程时不要沿用 v3 语法。

#### 3. D1 Migrations（数据库版本化）
- **URL**：https://developers.cloudflare.com/d1/reference/migrations/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Jun 8, 2026）
- **一句话价值**：`migrations/*.sql` + `d1_migrations` 表的完整机制，含 `migrations_table` / `migrations_dir` / `migrations_pattern` 三个可自定义项。
- **适用性备注**：
  - **重要坑**：官方建议**用 database name 而不是 binding name** 跑迁移——binding 可改名，database name 不能，否则容易把迁移打到错误分支库上。
  - 用 Drizzle 等 ORM 时迁移是"每迁移一个子目录"，必须配 `migrations_pattern`（如 `migrations/*/migration.sql`），且新迁移要用 ORM 自己生成，`wrangler d1 migrations create` 只会写顶层文件。
  - 涉及外键的表结构变更前要 `PRAGMA defer_foreign_keys = true`。

#### 4. D1 Wrangler 命令参考（迁移 / 导入导出 / Time Travel）
- **URL**：https://developers.cloudflare.com/workers/wrangler/commands/d1/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Apr 23, 2026）
- **一句话价值**：`d1 migrations create/list/apply`、`d1 execute`、`d1 export`、`d1 time-travel` 的权威参数表。
- **适用性备注**：`d1 migrations apply` 在 CI 环境会**跳过确认但仍自动备份**；单条迁移失败会回滚该条、保留上次成功状态——这点对"论坛上线日改表"很关键。

#### 5. D1 定价与免费额度
- **URL**：https://developers.cloudflare.com/d1/platform/pricing/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Apr 21, 2026）
- **一句话价值**：把"免费额度"量化到可预算的程度。
- **适用性备注（关键数字，2026-04 版）**：
  - Free：**5,000,000 rows read/天、100,000 rows written/天、5 GB 存储**；超限后**直接报错不可查询**（不是降级），免费额度每日 00:00 UTC 重置。
  - Paid：250 亿 rows read/月起 + 5000 万 rows written/月起，超出按 $0.001/百万读、$1.00/百万写计费。
  - **`rows_read` 按扫描行数算，不按返回行数算**——`SELECT *` 全表扫描 + 无索引过滤是免费额度杀手。每个查询返回的 `meta.rows_read` 可直接用来估算。
  - 无 egress 流量费。

#### 6. D1 限制（决定架构的一页）
- **URL**：https://developers.cloudflare.com/d1/platform/limits/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Apr 21, 2026）
- **一句话价值**：所有"能不能这么设计"的答案都在这张表里。
- **适用性备注**：
  - **单库 500 MB（Free）/ 10 GB（Paid，且不可再提额）**；Free 每账号 10 个库。
  - **每个 D1 库是单线程、一次处理一条查询** → 吞吐 ≈ 1/查询耗时；官方建议用 `batch()` 把多语句合并成一次请求以摊薄开销，队列满了会返回 `overloaded`。
  - 每次 Worker 调用最多 **6 条并发出向连接**（含 D1）；SQL 最长 30 秒；单语句 100 KB；字符串/行最大 2 MB。
  - 大批量 `UPDATE/DELETE` 必须分批（建议 1000 行/批），否则超执行限制。

#### 7. Workers 平台限制（CPU / 内存 / 子请求）
- **URL**：https://developers.cloudflare.com/workers/platform/limits/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Oct 12, 2026）
- **一句话价值**：整份报告里**最影响技术选型**的一页。
- **适用性备注**：
  - Free：**100,000 请求/天、CPU 10 ms/请求、内存 128 MB、子请求 50/请求**；超日请求返回 **Error 1027**。
  - Paid：CPU 上限 **5 分钟，默认 30 秒**（`limits.cpu_ms` 可调）；子请求 10,000。
  - **CPU time 只算真正占 CPU 的时间**，`fetch()`/KV/D1 等待时间不计入——这是"能不能在 Worker 里做慢哈希"的关键前提（见 1.5）。
  - 官方给的量级参考：普通 Worker 平均 2.2 ms/请求，"含认证、SSR、大 payload 解析"的重活通常 10–20 ms —— 也就是说**免费档 10 ms 的余量非常小**。
  - 超限表现为 Error 1102 `Worker exceeded resource limits`，日志里 invocation outcome 记为 `exceededCpu`。

#### 8. Workers 最佳实践（官方）
- **URL**：https://developers.cloudflare.com/workers/best-practices/workers-best-practices/ ✅ 已抓取（Last updated Oct 12, 2026）
- **来源**：Cloudflare 官方文档
- **一句话价值**：官方基于生产实践整理的"能跑 → 跑得稳"清单，含大量 🔴 反例 / ✅ 正例对照代码。
- **适用性备注（挑对本项目最有用的几条）**：
  - **`waitUntil()` 两个坑**：解构 `ctx` 会丢 `this` 绑定直接抛 `Illegal invocation`；响应发出后最多只能续 30 秒。
  - **禁止把请求级状态放模块级变量**：isolate 跨请求复用，会串数据并报 `Cannot perform I/O on behalf of a different request`。
  - **流式处理**：128 MB 内存下不要 `await response.text()` 全量缓冲，用 `new Response(response.body, response)` 透传。
  - **安全**：token 用 `crypto.getRandomValues()` / `crypto.randomUUID()`，禁用 `Math.random()`；比较密钥用 `crypto.subtle.timingSafeEqual()`，且**先把两边摘要成定长再比**（避免长度泄漏）。
  - 配置侧：`compatibility_date` 保持最新、开 `upload_source_maps`、用 `wrangler types` 生成 `Env`（别手写）、secrets 走 `wrangler secret put`。
  - 🔶 **最重要的一句（原文）**：*"Workers Static Assets is the recommended way to deploy static sites... If you are starting a new project, use Workers instead of Pages. Pages continues to work, but new features and optimizations are focused on Workers."* —— 这是官方对新项目的明确表态，直接关系到本项目"Cloudflare Pages 那一侧要不要改走 Workers"的决策。

#### 9. Vite 官方中文文档 · 部署静态站点（含 Cloudflare / Pages / GH Pages）
- **URL**：https://cn.vite.dev/guide/static-deploy ✅ 已抓取
- **来源**：Vite 官方中文文档（v8.3.x）
- **一句话价值**：**中文资料里最靠谱的一份**"构建期静态站怎么部署"指南，而且直接给了 GitHub Pages 与 Cloudflare Pages 两条完整路径。
- **适用性备注**：
  - GH Pages 章节明确写了 `base` 规则：部署到 `https://<USER>.github.io/` 或自定义域 → `base: '/'`；部署到 `https://<USER>.github.io/<REPO>/` → `base: '/<REPO>/'`。
  - 给出了现成的 `.github/workflows/deploy.yml`（`configure-pages` → `upload-pages-artifact` → `deploy-pages`），可直接抄。
  - Cloudflare Pages 章节给了 Git 集成与自定义域的操作路径。

**本节结论（可直接写进论坛公告）**
1. 免费档的 D1 **写额度只有 10 万行/天**，论坛"发帖+回帖+点赞+session 写入"很容易撞线，早期就要设计好索引与批量写。
2. D1 **单库单线程**是硬约束：热点表（帖子列表、楼中楼）必须走索引 + `batch()`，否则并发一上来就是 `overloaded`。
3. 迁移请统一用 **database name**，CI 里跑 `migrations apply`，不要手工 `execute` 改线上表。

---

### 1.2 Pages / GitHub Pages 静态站部署（最新正确做法）

#### 10. GitHub Pages 发布源配置（中文官方文档）
- **URL**：https://docs.github.com/zh/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site ✅ 已抓取
- **来源**：GitHub Docs 中文版
- **一句话价值**：把"分支发布"和"Actions 发布"两条路讲清楚，并给出官方推荐的工作流骨架。
- **适用性备注**：
  - 官方推荐流程：`checkout` → 构建 → `actions/upload-pages-artifact` → `actions/deploy-pages`，部署环境名 `github-pages`。
  - **关键坑（对本项目直接影响）**：文档明确说明——**用自定义 Actions 工作流发布时，仓库里的 `CNAME` 文件不会自动生效，且会被忽略**；自定义域必须在仓库 Settings 或 REST API 里配置。想靠"提交 CNAME 文件"切域名是行不通的。
  - 另一个坑：**用 `GITHUB_TOKEN` 推送的提交不会触发 Pages 构建**（避免循环），所以不要设计"Actions 提交产物再触发构建"的链路。

#### 11. GitHub Pages 使用限制（合规红线）
- **URL**：https://docs.github.com/zh/pages/getting-started-with-github-pages/github-pages-limits ✅ 已抓取
- **来源**：GitHub Docs 中文版
- **一句话价值**：把"GitHub Pages 能不能用来跑论坛"这个问题一次性判掉。
- **适用性备注（重要）**：
  - 站点 ≤ **1 GB**，源仓库建议 ≤ 1 GB；**软带宽 100 GB/月**；部署超 **10 分钟**会超时。
  - **软限制 10 次构建/小时——使用自定义 Actions 工作流时不适用**（所以走 Actions 反而没有这个枷锁）。
  - **合规红线**：GitHub Pages **不得用于运行在线业务、电商或商业 SaaS**，且官方明确写"**站点不应用于敏感事务，例如发送密码或信用卡号码**"。
  - 结论：GitHub Pages 只当**纯静态只读镜像**用，登录/发帖等一切敏感交互必须走 Cloudflare API 域；这一点也要在论坛规则里写清。

#### 12. GitHub Pages 自定义域管理（DNS 记录表）
- **URL**：https://docs.github.com/zh/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site ✅ 已抓取
- **来源**：GitHub Docs 中文版
- **一句话价值**：Apex 域 / 子域的 DNS 记录值、`CNAME` 指向规则、强制 HTTPS、域验证（防接管）全在这一页。
- **适用性备注**：子域 CNAME **必须指向 `<user>.github.io` 或 `<org>.github.io`，不带仓库名**；官方强烈不建议通配符 DNS（接管风险）；建议先验证域再加。

#### 13. `actions/deploy-pages`（官方 Action）
- **URL**：https://github.com/actions/deploy-pages ✅（通过 GitHub REST API 验证：`actions/deploy-pages`，MIT，962 stars，最近推送 2026-09-07）
- **来源**：GitHub Actions 官方组织
- **一句话价值**：把 Pages 部署从"推 gh-pages 分支"变成"发布 artifact"，产物不可变、可追溯。
- **适用性备注**：页面 HTML 本次抓取被网络拦截，仓库真实性以 `api.github.com/repos/actions/deploy-pages` 返回为准。需与 `actions/upload-pages-artifact`、`actions/configure-pages` 配套使用。

#### 14. Cloudflare Pages 自定义域
- **URL**：https://developers.cloudflare.com/pages/configuration/custom-domains/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Apr 21, 2026）
- **一句话价值**：apex 域必须把域托管进 Cloudflare（改 NS）；子域只需加 CNAME 指向 `<PROJECT>.pages.dev`。
- **适用性备注**：
  - **必须先在后台上关联域名，再加 DNS**；只加 CNAME 不关联会 522。
  - 已知坑：CAA 记录若不允许 Cloudflare 的 CA（letsencrypt/pki.goog/ssl.com）会导致证书签发失败。
  - 域名切走再切回会有"未激活"窗口期，临时下线应改用 Redirect Rule 而非改 DNS。

#### 15. Cloudflare Pages 限制（额度速查）
- **URL**：https://developers.cloudflare.com/pages/platform/limits/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Sep 5, 2026）
- **一句话价值**：Free 档 **500 次构建/月、同时 1 个构建、单次构建 20 分钟超时、20,000 文件、单文件 25 MiB、100 个自定义域、100 个项目**。
- **适用性备注**：本项目"构建期静态生成 → 只上传 `dist`"的模式**不消耗构建次数**（构建在 GitHub Actions 里做，Pages 只做 Direct Upload），这点值得在教程里点明。

#### 16. 用 Wrangler 在 CI 里直传 Pages（Direct Upload）
- **URL**：https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Sep 18, 2026）
- **一句话价值**：**与本项目架构最贴合的一篇**——同一份产物既发 GitHub Pages、又发 Cloudflare Pages 的标准做法。
- **适用性备注**：
  - 核心命令：`npx wrangler pages deploy <DIR> --project-name=<NAME>`，配合 `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`（权限：Account → Cloudflare Pages → Edit）。
  - 官方给的 GitHub Actions 片段用 `cloudflare/wrangler-action@v4`，并需 `permissions: contents: read, deployments: write`。
  - **产物完全一致、只有域名不同**这个前提正好成立：Wrangler 直传不参与构建，所以两个域拿到的是同一个 `dist`。

#### 17. Cloudflare 官方方向：Pages → Workers（2026 年必须知道）
- **URL**：https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Oct 12, 2026）
- **一句话价值**：Cloudflare 已经提供"从 Pages 迁到 Workers 静态资源"的官方迁移指南与兼容性对照表——**说明 Workers Static Assets 是官方主推方向**，Pages 更多处于维护态。
- **适用性备注（对"是否继续用 Pages"的决策很关键）**：
  - **官方在《Workers Best Practices》里已明确写**：*"If you are starting a new project, use Workers instead of Pages. Pages continues to work, but new features and optimizations are focused on Workers."* —— 也就是说 Pages 仍在正常服务、但**新特性只往 Workers 走**。
  - 对照表里 Pages 独有 / 落后的项：自定义域**不需要**托管在 Cloudflare 的 zone（Workers 的硬限制：**域名 NS 必须在 Cloudflare**）、Early Hints、`_routes.json` 那套 file-based routing。
  - Workers 侧多出来的：Logpush / Tail Workers / Source Maps / 渐进部署 / 按路径托管静态资源（`serving a subdirectory`）/ Rate Limiting 绑定。
  - **对本项目的落点**：现在这套"双静态域 + 单一 API"完全可以在 Pages 上跑（它也确实是"只上传 `dist`"的最短路径），**短期不必迁移**；但如果将来要把前端和 API 合成一个 Worker、或用上 Logpush / Rate Limiting 绑定，迁移路径已经现成。

**本节结论（给工程的具体建议）**
1. 两个域**同一份 `dist`**：GitHub Actions 里跑一次 `build`，然后 ①`upload-pages-artifact` + `deploy-pages` 发 GH Pages；②`wrangler pages deploy` 发 Cloudflare Pages。
2. **相对路径**是这套方案的关键前提：站点内链全部相对化后，`/repo/` 子路径与根域都能跑；但**站点地图/canonical 里的绝对 URL 必须按域名分别生成**，这是唯一必须"两份"的东西。
3. GitHub Pages 侧**不要配任何登录/表单直连**（官方 ToS 明确禁止敏感事务），所有写操作打到 Cloudflare API。
4. 记住两个"不生效"：GH Pages 自定义工作流下 `CNAME` 文件无效；`GITHUB_TOKEN` 推送不触发 Pages 构建。

---

### 1.3 静态站 + 跨域 API 的认证方案（Bearer vs Cookie）

#### 18. MDN · 跨源资源共享（CORS）
- **URL**：https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Guides/CORS ✅ 已抓取
- **来源**：MDN Web Docs 中文版
- **一句话价值**：中文里最权威的 CORS 解释，预检（preflight）、简单请求、`Access-Control-Allow-Credentials` 的语义都在这。
- **适用性备注**：**核心规则**——`Access-Control-Allow-Origin: *` 与 `credentials: 'include'` **不可同时使用**。这直接决定了"两个域名 + 一个 API"必须走哪种认证（见本节结论）。

#### 19. MDN · `Set-Cookie`（含 SameSite）
- **URL**：https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Reference/Headers/Set-Cookie ✅ 已抓取
- **来源**：MDN Web Docs 中文版
- **一句话价值**：`SameSite=Lax/Strict/None`、`Secure`、`Domain` 的准确定义与默认值。
- **适用性备注**：跨站（github.io → 你的 API 域）要用 Cookie，必须 `SameSite=None; Secure`，且浏览器正在推进**第三方 Cookie 限制**——这是长期风险，不是配置问题。

#### 20. OWASP · 密码存储速查表（认证侧的硬参数）
- **URL**：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html ✅ 已抓取
- **来源**：OWASP Cheat Sheet Series
- **一句话价值**：PBKDF2 迭代次数的权威取值 + 盐/pepper 的正确用法。
- **适用性备注**：**PBKDF2-HMAC-SHA256 推荐 600,000 次迭代**（SHA-512 为 220,000）；明确"计算一次哈希应 < 1 秒"；pepper 必须与哈希分开存储（Workers 里就是 Secret）。

**本节结论（针对"GitHub Pages 跨域调 Cloudflare API"）**
1. **推荐 Bearer Token（放 `Authorization` 头），不要用 Cookie。**
   - 原因一：`github.io` 与 API 域是**不同站点**，Cookie 必须 `SameSite=None; Secure`，属第三方 Cookie，正被浏览器逐步限制。
   - 原因二：`Access-Control-Allow-Origin` 需要**同时放行两个前端域**（回显 Origin 白名单 + `Vary: Origin`），而带凭证时不能用 `*`，配置复杂度陡增。
   - 原因三：Bearer 天然免疫 CSRF（不随请求自动携带），前端把 token 放内存 + `Authorization` 头即可。
2. **Token 存哪里**：`localStorage` 会被 XSS 直接读走；更稳的是"**短期 access token 放内存 + refresh token 用 `HttpOnly` Cookie 限定在 API 域**"的混合方案，但这对纯静态站 + 双域是过度设计——论坛阶段建议 **短期 Bearer（如 1 小时）+ 可撤销的 session 表（D1）**。
3. **API 侧必须做**：Origin 白名单校验（不是 `*`）、预检缓存 `Access-Control-Max-Age`、`Vary: Origin`、限流（可用 Workers Rate Limiting 绑定）。
4. **永远不要在 GitHub Pages 侧处理密码**：官方 ToS 已明确 Pages 不适合"发送密码"类敏感事务。

---

### 1.4 双静态前端 + 单一 API 的 SEO 处理

#### 21. Google · 如何使用 `rel="canonical"` 指定规范网址（中文）
- **URL**：https://developers.google.cn/search/docs/crawling-indexing/consolidate-duplicate-urls?hl=zh-cn ✅ 已抓取（正文导航已确认；`developers.google.com` 直连在本环境失败，`.cn` 为同一份官方文档）
- **来源**：Google 搜索中心官方文档
- **一句话价值**：canonical 的官方定义与"自引用 canonical"的推荐写法。
- **适用性备注**：官方立场是 canonical 是**提示（hint）而非指令**；同时给出 sitemap、301、内链等"其他指定规范网址的方法"——这对"同一内容两个域"的场景正好是决策依据。

#### 22. Google · 创建和提交站点地图（中文）
- **URL**：https://developers.google.cn/search/docs/crawling-indexing/sitemaps/build-sitemap?hl=zh-cn ✅ 已抓取
- **来源**：Google 搜索中心官方文档
- **一句话价值**：sitemap 的格式要求、大小/条数上限、以及"提交 sitemap 不等于保证收录"的官方口径。
- **适用性备注**：**sitemap 里的 `<loc>` 必须是绝对 URL**——这就是"两份产物不同"的唯一硬性位置；建议构建时按 `SITE_ORIGIN` 环境变量各生成一份 `sitemap.xml` 与 `robots.txt`。

#### 23. Vite · `base` 配置项（子路径 base path 的官方答案）
- **URL**：https://vite.dev/config/shared-options#base ✅ 已抓取
- **来源**：Vite 官方文档
- **一句话价值**：`base` 的三种合法取值（`/foo/`、完整 URL、`./` 或空串用于嵌入式部署），是子路径部署不 404 的根因解释。
- **适用性备注**：**"内链用相对路径"不等于可以不要 `base`**：`base` 决定的是**构建产物的资源引用前缀**（JS/CSS/图片），相对内链决定的是**页面间跳转**。两者要分开处理；若确实要"一份产物两处用"，用 `base: './'` 最省事，但会牺牲部分路由能力。

**本节结论（双域 SEO 的可行策略，二选一）**

| 策略 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| **A. 各自自引用 canonical**（推荐先做） | 每个域生成自己的 `sitemap.xml` + `robots.txt`，`<link rel="canonical">` 指向**本域同一路径**，JSON-LD `url`/`@id` 也用本域绝对地址 | 实现简单，两个域都有机会被收录；不会互相"打脸" | 内容重复，Google 可能只保留一个版本（会自行聚类），另一个域可能被过滤 |
| **B. 跨域 canonical 收敛** | 两个域都把 canonical 指向**选定主域**，副域 sitemap 仍提交（或干脆不提交） | 权重集中，明确主域 | 副域基本不会被收录；一旦主域故障，SEO 归零 |

- **绝不要做的事**：A 域 canonical 指 B 域、B 域 canonical 指 A 域（互相指向）——Google 会同时忽略两个 canonical。
- **JSON-LD 注意**：`@id` 与 `url` 必须与 canonical 同域同路径，否则结构化数据与规范网址冲突。
- **RSS**：RSS 不是 canonical 的替代品，但它能让聚合器与部分爬虫发现新帖；同样按域生成绝对链接。
- **重复内容的现实预期**：同内容双域，长期看几乎必然有一个域被"过滤展示"。如果目标是"两个入口都活着、都能被搜到"，就选 A 并接受副域流量较少；如果目标是"集中权重"，就选 B，并把副域当纯镜像/备用入口。

---

### 1.5 Workers 上做密码哈希（PBKDF2 via WebCrypto）

#### 24. Workers · Web Crypto API（支持哪些算法）
- **URL**：https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ ✅ 已抓取
- **来源**：Cloudflare 官方文档（Last updated Sep 30, 2026）
- **一句话价值**：确认 Workers **原生支持 PBKDF2**（`deriveBits()` / `deriveKey()` / `importKey()`），以及一个非标准但很有用的扩展 `crypto.subtle.timingSafeEqual()`。
- **适用性备注**：
  - 官方明确："**用 Web Crypto 做密码学运算显著快于纯 JS 实现**；CPU 密集型加密操作应优先用 Web Crypto"——这正是"能不能在 10 ms 内算完"的前提。
  - PBKDF2 只出现在 `deriveBits/deriveKey` 列，**没有 `encrypt/decrypt`**，别按 Node 的 `crypto.pbkdf2` 习惯写。
  - `timingSafeEqual` 是 Cloudflare 扩展，校验哈希时用它，不要用 `===`。
  - 与 Node Crypto API 差异大；要用 Node 风格需开 `nodejs_compat`。

#### 25. OWASP · 密码存储速查表（迭代次数与算法选择）
- **URL**：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html ✅ 已抓取
- **来源**：OWASP Cheat Sheet Series
- **一句话价值**：给出"该用多少迭代"的可执行数字，并解释为何 PBKDF2 只在 FIPS 场景优先。
- **适用性备注**：
  - 首选 **Argon2id**（m=19 MiB, t=2, p=1）；scrypt 次之；**PBKDF2 是"FIPS-140 合规要求时"的首选**。
  - PBKDF2 数字：**SHA-256 → 600,000 次**；SHA-512 → 220,000 次；SHA-1 → 1,400,000 次（仅遗留系统）。
  - 官方经验法则："一次哈希计算应 **< 1 秒**"——这句话在 Workers 免费档下几乎无法满足（见下）。
  - 附带一个真实 DoS 提醒：PBKDF2 对超长密码（> 64 字节块）可能每轮都预哈希，Django 2013 年就因此出过漏洞 → **先限制密码长度上限**。

**本节结论（这是全报告最重要的工程警告）**

1. **免费档 10 ms CPU 做不了正经 PBKDF2。** 600,000 次 HMAC-SHA256 迭代在任何运行时都是几十到几百毫秒级 CPU 开销，比 Free 档 10 ms 高 1–2 个数量级；一旦超限就是 Error 1102，且**失败发生在登录路径上**（最糟的位置）。
2. **可选路线（按推荐度）**：
   - **A. 升 Workers Paid（$5/月）+ 显式设 `cpu_ms`**：默认 30 秒足够覆盖 PBKDF2；这是最省心的正解，也是本项目"论坛要能注册登录"的现实前提。
   - **B. 降迭代次数到能跑完（如 100k）并接受弱化**：不推荐作为长期方案，且需在文档里写明安全折衷；OWASP 基线是 60 万。
   - **C. 把哈希放进 Durable Object**：仍受 Workers CPU 限制约束（DO 也是 Workers 运行时），只是便于串行化与限流，**不能突破 CPU 上限**。
   - **D. 不在边缘做哈希**：交给外部服务/构建期不可行（运行时才发生）。不推荐。
3. **无论哪条路线都必须配套**：
   - 登录接口**限流**（按 IP + 账号双维度），否则 PBKDF2 本身就是 DoS 放大器（OWASP 明确警告过 work factor 导致的 DoS）。
   - **密码长度上限**（如 8–128 字节）前置校验，防止超长输入放大 CPU。
   - 哈希格式里**存放算法与迭代次数**（PHC 风格），便于将来无缝升级迭代次数（登录时重哈希）。
   - 校验用 `crypto.subtle.timingSafeEqual()`。

---

## 第二章 AI 越狱/提示词攻防：高质量学习资料

> **收录原则**：只收标准、论文、评测基准、防御指南、开源评测工具与社区清单；**不收录"可操作的越狱提示词教程/提示词库"**（符合社区规则）。个别资料本身含攻击技术细节（如 Anthropic 的研究博客），已单独标注阅读定位。

### 2.1 标准与框架类（先建立共同语言）

#### 1. OWASP Top 10 for LLM Applications（2025）
- **URL**：https://genai.owasp.org/llm-top-10/ ✅ 已抓取（HTTP 200，标题 "LLMRisks Archive - OWASP Gen AI Security Project"；正文为 JS 渲染，未取到完整条目文本）
- **单条入口（已验证正文）**：https://genai.owasp.org/llmrisk/llm01-prompt-injection/ ✅ 已抓取（标题 `LLM01:2025 Prompt Injection`）
- **简介**：LLM 应用十大风险清单，LLM01 即提示词注入；每条含描述、攻击场景、缓解措施与参考。
- **为什么值得推荐**：**事实上的行业通用编号体系**。论坛里讨论"这是 LLM01 还是 LLM06"比自造术语高效得多；也是做威胁建模时最省事的起点。
- **是否适合初学者**：✅ 非常适合，作为第一篇读物。建议从 LLM01 单页读起。

#### 2. OWASP · LLM Prompt Injection Prevention Cheat Sheet
- **URL**：https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html ✅ 已抓取
- **简介**：**防御视角**的系统化清单：直接/间接注入、编码与混淆、Typoglycemia、Best-of-N、HTML/Markdown 注入、系统提示词提取、数据外泄、多模态、RAG 投毒、Agent 专属攻击，再到输入校验、结构化提示、输出监控、HITL、最小权限、监控告警。
- **为什么值得推荐**：**这是本报告里"防御侧"信息密度最高的一篇**，而且写法非常"工程可落地"：明确说"输入过滤不是安全边界"、引 NCSC 的"prompt injection is not SQL injection"、给出 NFKC/UTS#39/Unicode tag 字符的处理细节，还给了 Best-of-N 的实证数字（GPT-4o 89%、Claude 3.5 Sonnet 78%，最多 1 万次增强尝试）。
- **是否适合初学者**：🟡 中等偏进阶——建议读完 LLM01 再读，否则术语密度偏高。

#### 3. NIST AI 100-2 E2025 · Adversarial Machine Learning: Taxonomy and Terminology
- **URL**：https://csrc.nist.gov/pubs/ai/100/2/e2025/final ✅ 已抓取（PDF：https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-2e2025.pdf）
- **简介**：NIST 的对抗机器学习分类学与术语标准（2025 年 3 月发布），按"ML 方法类型 × 攻击生命周期阶段 × 攻击者目标/能力/知识"组织，并给出缓解与管理方法。作者含 NIST、Northeastern、Cisco、UK AI Security Institute、US AI Safety Institute。
- **为什么值得推荐**：**引用它就不会在术语上被挑刺**（"evasion / poisoning / privacy breach"的边界）。做论坛的"术语表"页面时，这是最稳的底稿。
- **是否适合初学者**：🟡 中等——是 taxonomy 不是 tutorial，适合当参考手册而非通读。

#### 4. OWASP · AI Agent Security Cheat Sheet（延伸）
- **URL**：https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html
- **验证**：🟡 仅搜索可见（在 OWASP Cheat Sheet 索引列表中确认存在，本次未逐页打开）
- **简介**：面向带工具/权限的 Agent 的安全清单，含"高影响动作完整性控制"等。
- **为什么值得推荐**：论坛若讨论"Agent 被注入后能干什么"，这页比泛泛的 LLM 清单更贴题。
- **是否适合初学者**：🟡 中等。

### 2.2 论文类（可作为"每周论文"种子）

#### 5. Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection
- **URL**：https://arxiv.org/abs/2302.12173 ✅ 已抓取
- **作者/年份**：Greshake, Abdelnabi, Mishra, Endres, Holz, Fritz（2023，v2）
- **简介**：**间接提示词注入（Indirect Prompt Injection）的奠基论文**。提出"LLM 集成应用模糊了数据与指令的边界"，给出安全视角的分类学（数据窃取、蠕虫化、信息生态污染等），并在 Bing Chat（GPT-4）与代码补全引擎上验证。
- **为什么值得推荐**：论坛里 90% 的"提示词注入"讨论都应该先读这篇，否则会把"越狱"和"注入"混为一谈。
- **是否适合初学者**：✅ 适合（有少量术语，但论证链条清晰）。

#### 6. AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents
- **URL**：https://arxiv.org/abs/2406.13352 ✅ 已抓取（代码：https://github.com/ethz-spylab/agentdojo）
- **作者/年份**：Debenedetti, Zhang, Balunović, Beurer-Kellner, Fischer, Tramèr（2024，v3）
- **简介**：面向"会调工具的 Agent"的**可扩展评测环境**：97 个真实任务（邮件、网银、差旅）、629 个安全测试用例，支持自定义攻击与防御。
- **为什么值得推荐**：想量化"我的防御到底有没有用"时，这是最现成的实验床；也适合做论坛的"防御挑战赛"底座。
- **是否适合初学者**：❌ 偏进阶（需要跑 Python、理解 Agent 框架）。

#### 7. JailbreakBench: An Open Robustness Benchmark for Jailbreaking LLMs
- **URL**：https://arxiv.org/abs/2404.01318 ✅ 已抓取（NeurIPS 2024 D&B；代码 https://github.com/JailbreakBench/jailbreakbench ；榜单 https://jailbreakbench.github.io/）
- **简介**：开源越狱鲁棒性基准：持续更新的攻击 artifact 库、100 条与 OpenAI 使用政策对齐的行为数据集、标准化评测框架（威胁模型/系统提示/对话模板/打分函数）、排行榜。
- **为什么值得推荐**：**解决"各家用不可比的成功率吹牛"这个痛点**——它把成本、成功率、可复现性统一了。论坛引用它做横向对比最有说服力。
- **是否适合初学者**：🟡 中等（想做评测才需要深入；读摘要与榜单即可建立直觉）。

#### 8. HarmBench: A Standardized Evaluation Framework for Automated Red Teaming and Robust Refusal
- **URL**：https://arxiv.org/abs/2402.04249 ✅ 已抓取（CC BY 4.0；站点 https://www.harmbench.org ；代码 https://github.com/centerforaisafety/HarmBench ✅ 已抓取，MIT，约 1.1k stars）
- **作者/年份**：Mazeika, Phan, Yin, Zou, Wang, Mu, Sakhaee, Li, Basart, Li, Forsyth, Hendrycks（2024，v2；Center for AI Safety 等）
- **简介**：自动化红队与鲁棒拒答的标准化评测框架。论文做了**18 种红队方法 × 33 个目标模型/防御**的大规模横向对比，并提出一种高效的对抗训练方法提升鲁棒性。
- **为什么值得推荐**：与 JailbreakBench 互补——一个偏"行为集+榜单"，一个偏"**红队方法学与防御训练的量化对比**"。做"红队工具横评"或"防御到底有没有用"时，这两个基准是标准引用。
- **是否适合初学者**：❌ 偏进阶（18×33 的实验矩阵对新手不友好，建议先看结论表）。🔶 **注意**：代码仓库最近推送为 2024-08，属"稳定但不再活跃"，引用时注明版本。

### 2.3 工具类（防御方与评测方）

#### 9. NVIDIA garak — the LLM vulnerability scanner
- **URL**：https://github.com/NVIDIA/garak ✅ 已抓取（GitHub API：Apache-2.0，约 9.6k stars，最近推送 2026-10-21）
- **简介**：LLM 漏洞扫描器（探针/检测器架构），覆盖幻觉、数据泄露、提示词注入、越狱等漏洞族。
- **为什么值得推荐**：**最像"nmap for LLM"的工具**，社区活跃、可 CI 化；论坛可开"garak 扫我的 bot"实战帖。
- **是否适合初学者**：🟡 中等（CLI 上手容易，但读懂报告需要一点基础）。

#### 10. Microsoft PyRIT（Python Risk Identification Tool for generative AI）
- **URL**：https://github.com/microsoft/PyRIT ✅ 已抓取（GitHub API：MIT，约 4.7k stars，最近推送 2026-10-22；文档 https://microsoft.github.io/PyRIT/）
- **简介**：微软开源的红队框架，强调"让安全人员与工程师主动识别生成式 AI 风险"，含编排器、转换器、评分器。
- **为什么值得推荐**：**企业级红队流程的参考实现**，适合讲"红队不是手搓提示词，而是可重复的流水线"。
- **是否适合初学者**：❌ 偏进阶。

#### 11. promptfoo
- **URL**：https://github.com/promptfoo/promptfoo ✅ 已抓取（GitHub API：MIT，约 26k stars，最近推送 2026-10-22；站点 https://promptfoo.dev）
- **简介**：提示词/Agent/RAG 的测试与红队框架，声明式 YAML 配置、CLI + CI/CD 集成，官方描述提到被 OpenAI 与 Anthropic 使用。
- **为什么值得推荐**：**最适合"论坛成员自己动手"的一个**——配置简单、能进 CI，适合做"我的 system prompt 抗注入回归测试"这类帖子。
- **是否适合初学者**：✅ 相对友好（会写 YAML 就能起步）。

### 2.4 清单/社区/研究机构（内容种子池）

#### 12. Awesome LLM Security（corca-ai）
- **URL**：https://github.com/corca-ai/awesome-llm-security ✅ 已抓取（GitHub API：约 1.7k stars，最近推送 2025-08-20）
- **简介**：LLM 安全工具、文档、项目的精选清单。
- **为什么值得推荐**：**做论坛"资源库"页面的现成骨架**，一次拿全工具地图。
- **是否适合初学者**：✅ 适合。🔶 注意维护节奏（2025-08 后无推送），引用时说明"清单可能滞后"。

#### 13. Simon Willison · Prompt injection 系列
- **URL**：https://simonwillison.net/series/prompt-injection/ ✅ 已抓取
- **简介**：从 2022 年"提示词注入"被命名开始，持续 4 年的系列文章。必读单篇：
  - 《Prompt injection and jailbreaking are not the same thing》（2024-03-05）——**术语纠偏的关键一篇**
  - 《The lethal trifecta for AI agents》（2025-06-16）——私有数据 + 不可信内容 + 对外通信
  - 《Design Patterns for Securing LLM Agents against Prompt Injections》（2025-06-13，评介 arXiv 2506.08837）
  - 《New prompt injection papers: Agents Rule of Two and The Attacker Moves Second》（2025-11-02）
- **为什么值得推荐**：**英文世界里最好的"概念澄清 + 论文导航"**，文风克制、几乎每篇都给原始论文链接。论坛可以直接按时间线做"注入史"专栏。
- **是否适合初学者**：✅ 非常适合，建议从《not the same thing》入门。

#### 14. Anthropic · Mitigating prompt injections in browser use
- **URL**：https://www.anthropic.com/research/prompt-injection-defenses ✅ 已抓取（注意：`/news/prompt-injection-defenses` 会 301 到 `/research/...`，引用请用最终地址）
- **简介**：官方披露浏览器 Agent 的注入防御进展：用 RL 训练抗注入、对进入上下文的不可信内容做分类器扫描、大规模人工红队；给出内部 Best-of-N 攻击下的 ASR（Opus 4.5 降到 1.4%，并明确"1% 仍是真实风险"）。
- **为什么值得推荐**：**少见的"厂商自曝 ASR 数字"**，适合讲"防御是概率收敛，不是消灭"。
- **是否适合初学者**：✅ 适合（叙事型，无攻击配方）。

#### 15. Anthropic · Many-shot jailbreaking（研究披露）
- **URL**：https://www.anthropic.com/research/many-shot-jailbreaking ✅ 已抓取
- **简介**：长上下文带来的新型越狱：在单次提示里塞入大量"假对话"示例，超过阈值后模型更可能顺从；文中也讲了缓解（prompt 分类与改写，某配置下 ASR 从 61% 降到 2%）。
- **为什么值得推荐**：讲"上下文长度本身是攻击面"的最佳案例，且**重点在缓解**。
- **是否适合初学者**：🟡 中等。🔶 **阅读定位**：官方研究披露，含技术机制描述；论坛引用时**只做现象与防御讨论，不放可复现配方**。

#### 16. AI Vulnerability Database（AVID）
- **URL**：https://avidml.org/ ✅ 已抓取
- **简介**：AI Risk and Vulnerability Alliance 维护的**开放 AI 漏洞/失效数据库**，含结构化证据、可复现评测细节，以及多套分类法的映射（AVID taxonomy 只是其中之一）。
- **为什么值得推荐**：论坛"漏洞案例库"板块可以直接对标它的字段设计（证据、元数据、复现步骤），比自造模板专业。
- **是否适合初学者**：✅ 适合（按条目读，不需要前置知识）。

### 2.5 本章收录边界说明
- **已排除**：任何"越狱提示词合集/角色扮演模板/DAN 类模板库/bypass 技巧步骤"——即使用于研究，也会让论坛变成可操作攻击的分发点。
- **已排除**：以"教你怎么绕过某模型安全策略"为主旨的博客与视频教程。
- **保留的判断依据**：资料的主旨是**测量、分类、防御、披露流程**，而非提供可直接复用的攻击载荷。

---

## 三、链接状态汇总

### 3.1 不可访问 / 受限（本次调研实测）
| 链接 | 状态 | 说明与替代方案 |
| --- | --- | --- |
| `https://blog.cloudflare.com/zh-cn/making-full-stack-easier-d1-ga-hyperdrive-queues/` | ❌ `getaddrinfo ENOTFOUND blog.cloudflare.com` | 本环境 DNS 无法解析该域。Cloudflare 中文博客内容可由官方文档（`developers.cloudflare.com`）覆盖，本报告未依赖它 |
| `https://developers.openai.com/api/docs/guides/safety-best-practices` | ❌ HTTP **403**（"This request was blocked"） | OpenAI 官方安全指南在本环境被拦截，**故本报告未收录任何 OpenAI 官方链接**（避免给出无法验证的条目）。如需补齐，请人工在浏览器打开后补录 |
| `https://platform.claude.com/docs/...` / `https://docs.claude.com/...` | ❌ 跨域重定向无法自动跟随（`docs.claude.com` ↔ `platform.claude.com` 互跳） | 未能验证正文。替代：OWASP LLM Prompt Injection Cheat Sheet 中引用了该指南，可作二手引用 |
| `https://github.com/<任何仓库>`（HTML 页面） | ❌ `fetch failed`（本环境拦截 GitHub HTML） | **已用 `https://api.github.com/repos/<owner>/<repo>` 逐条验证仓库真实性与描述/许可证/活跃度**，结论可信；但页面正文（README）未能逐字核对 |
| `https://developers.google.com/search/docs/...` | ❌ `fetch failed` | 已改用 `developers.google.cn`（同一份官方文档的中文站）验证并引用 |
| `https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html` | ❌ 404 | 该 slug 不存在，已放弃引用（本报告未给出任何 JWT 速查表链接） |
| `https://genai.owasp.org/llm-top-10/` 正文 | 🟡 正文未取全 | 页面 HTTP 200 且标题正确，但主体由 JS 渲染；**条目级内容已用 `llmrisk/llm01-prompt-injection/` 单独验证** |

### 3.2 需注意时效/维护状态的链接
| 链接 | 注意点 |
| --- | --- |
| `github.com/centerforaisafety/HarmBench` | 最近推送 2024-08，稳定但不再活跃 |
| `github.com/corca-ai/awesome-llm-security` | 最近推送 2025-08，清单可能滞后 |
| Cloudflare 全部额度类页面 | 均标注了 Last updated（2026-04 ~ 2026-10），**额度与免费政策仍可能变化**，上线前复核 |
| `developers.cloudflare.com/.../migrate-from-pages/` 与 `/workers/best-practices/` | 反映 2026-10 的官方方向（**新项目建议用 Workers Static Assets，Pages 转入维护态**），一年后可能再变 |

---

## 四、最推荐的 5 个链接

1. **OWASP · LLM Prompt Injection Prevention Cheat Sheet** — https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
   *防御侧信息密度最高、可直接转成工程 checklist 的一篇。*

2. **Greshake et al. · Indirect Prompt Injection（arXiv:2302.12173）** — https://arxiv.org/abs/2302.12173
   *社区一切"注入"讨论的源头论文，用来统一术语最有效。*

3. **Cloudflare Workers 平台限制** — https://developers.cloudflare.com/workers/platform/limits/
   *10 ms CPU / 100k 请求 / 50 子请求——本项目所有架构取舍的硬边界。*

4. **Vite 官方中文文档 · 部署静态站点** — https://cn.vite.dev/guide/static-deploy
   *中文、最新、同时覆盖 GitHub Pages（含 `base` 规则与完整 workflow）与 Cloudflare Pages，直接可抄。*

5. **Simon Willison · Prompt injection 系列** — https://simonwillison.net/series/prompt-injection/
   *最好的概念澄清 + 论文导航，适合做论坛"入门必读"专栏的主线。*

---

## 五、给"破甲论坛"的行动建议（基于以上调研）

1. **认证方案定为 Bearer Token + D1 session 表**，禁用跨站 Cookie；API 侧做 Origin 白名单 + `Vary: Origin` + 预检缓存。
   *依据：MDN CORS 的 `*` 与 credentials 互斥规则 + 第三方 Cookie 收紧趋势。*

2. **密码哈希前先决定是否上 Workers Paid**。免费档 10 ms CPU 无法承载 600k 次 PBKDF2；若坚持免费档，必须在文档里明示安全降级，并加登录限流与密码长度上限。
   *依据：Workers limits + OWASP Password Storage。*

3. **两份产物只允许两个文件不同：`sitemap.xml` 与 `robots.txt`**（以及 HTML 里的 canonical / JSON-LD `url`）。其余全部相对路径共享。
   *依据：Google sitemap 要求 `<loc>` 为绝对 URL；canonical 需自引用。*

4. **SEO 先走"各自自引用 canonical"策略**，两个域各提交一份 sitemap；等确定主域后再考虑跨域收敛（并接受副域不被收录）。
   *依据：Google 的 canonical 是 hint，互相指向会导致双双失效。*

5. **GitHub Pages 只做只读镜像**，不承载任何登录/写操作。
   *依据：GitHub Pages Limits 明确"不应用于敏感事务（如发送密码）"。*

6. **论坛内容侧先上三块**：① 术语表（以 NIST AI 100-2 + Simon Willison 的"注入 ≠ 越狱"为骨架）；② 资源库（以 awesome-llm-security + OWASP 清单为骨架）；③ 论文/评测专栏（JailbreakBench / AgentDojo / HarmBench 三件套）。
   *依据：第二章各条的"适合初学者"标注。*

7. **社区规则要在内容里显性化**：只讨论测量、分类、防御、披露；不提供可复现攻击载荷。本报告已据此排除全部越狱提示词类资料。

---

*报告完 · 所有引用链接的验证状态见第三节；如后续需要补录 OpenAI 官方安全指南，请在可直连环境打开后追加。*
