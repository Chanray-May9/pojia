# 破甲论坛（pojia-forum）· 部署手册

> 本文件是**可逐条执行**的线上部署清单，覆盖 Cloudflare Worker + D1、GitHub Pages、Cloudflare Pages 与 SEO 验收。
>
> 标注说明：
> - ✅ **可本地验证**：不需要任何线上账号/凭据，命令在仓库根目录直接跑。
> - 🔑 **需要线上凭据，无法本地验证**：需要 Cloudflare / GitHub 账号、域名或 API Token，必须在真实环境执行并人工核对输出。
>
> 前置条件：Node.js **24+**、`git`；`wrangler` 使用全局安装或 `npx wrangler`（**不要**把它加进项目 `package.json` 依赖，本项目保持零 npm 依赖）。

---

## 0. 本地预检（无凭据）✅

在仓库根目录 `pojia-forum/` 执行：

```bash
# 0.1 Node 版本（需 >= 24；package.json 要求 >=22.5，但 node:sqlite 建议 24）
node -v

# 0.2 部署配置静态验收（QA 提供，检查 wrangler/workflow/schema 的关键字段）
node --test tests/deploy-config.test.mjs

# 0.3 迁移 SQL 可执行性（内存 SQLite，不写任何文件）
node -e "const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync('deploy/migrations/0001_init.sql','utf8'));const c=db.prepare('select count(*) as n from categories').get();console.log('categories =',c.n);"

# 0.4 本地端到端：启动 API（另开一个终端保持运行）
node backend/local-server.mjs            # http://127.0.0.1:4400

# 0.5 健康检查与板块种子
curl -sS http://127.0.0.1:4400/api/health
curl -sS http://127.0.0.1:4400/api/v1/categories

# 0.6 可选演示数据 + 构建 + 预览
node scripts/demo-data.mjs --api http://127.0.0.1:4400
node frontend/build.mjs --api http://127.0.0.1:4400 --site http://127.0.0.1:4401
node frontend/serve.mjs                  # http://127.0.0.1:4401
```

预期：`/api/health` 返回 `{"ok":true,...}`；`categories` 返回 7 个初始板块（用户可自建更多）；构建脚本输出 `[build] 完成` 与文件数统计。

> Windows PowerShell 中 `curl` 是 `Invoke-WebRequest` 别名，可改用 `curl.exe -sS ...` 或 `Invoke-RestMethod http://127.0.0.1:4400/api/health`。

---

## 1. 创建 D1 数据库 🔑

```bash
# 1.1 登录 Cloudflare（浏览器 OAuth，或设置 CLOUDFLARE_API_TOKEN）
npx wrangler login

# 1.2 创建数据库（名字必须是 pojia，与 deploy/wrangler.toml 的 database_name 一致）
npx wrangler d1 create pojia
```

把命令输出中的 `database_id` 填入 `deploy/wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "pojia"
database_id = "REPLACE_WITH_D1_ID"   # ← 替换为真实 id
migrations_dir = "migrations"
```

验证配置被 Wrangler 正确解析（不部署，仅解析）：

```bash
npx wrangler d1 info pojia --config deploy/wrangler.toml
```

预期输出包含数据库名、创建时间与 UUID。

---

## 2. 应用迁移（建表 + 7 个初始板块种子）🔑

```bash
# 2.1 应用迁移到线上 D1（migrations_dir 相对 deploy/，即 deploy/migrations/）
npx wrangler d1 migrations apply pojia --remote --config deploy/wrangler.toml

# 2.2 确认迁移已记录
npx wrangler d1 migrations list pojia --remote --config deploy/wrangler.toml

# 2.3 验证表与种子数据（关键验证命令）
npx wrangler d1 execute pojia --remote --config deploy/wrangler.toml \
  --command "SELECT COUNT(*) AS categories FROM categories"
# 预期：categories = 7

npx wrangler d1 execute pojia --remote --config deploy/wrangler.toml \
  --command "SELECT slug, name, sort_order FROM categories ORDER BY sort_order"
# 预期：jailbreak/injection/redteam/defense/tooling/vuln/general 依次 1..7
```

> 迁移文件与 `backend/schema.sql` 的表结构完全一致；`0001_init.sql` 末尾的 `INSERT ... ON CONFLICT(slug) DO UPDATE` 可重复执行且不产生重复行。
>
> 本地（不连线上）可先用 `--local` 跑一遍：`npx wrangler d1 migrations apply pojia --local --config deploy/wrangler.toml`（会在 `.wrangler/` 下建本地 D1，已被 .gitignore 忽略）。

---

## 3. 配置 Worker Secret 与非敏感变量 🔑

```bash
# 3.1 生成高强度随机密钥（本地生成，不经过第三方）
node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"

# 3.2 写入 Worker Secret（按提示粘贴上一步的值；不要写进 wrangler.toml 或仓库）
npx wrangler secret put APP_SECRET --config deploy/wrangler.toml

# 3.3 确认 secret 存在（只显示名字，不显示值）
npx wrangler secret list --config deploy/wrangler.toml
```

`[vars]` 已在 `deploy/wrangler.toml` 中配置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SITE_NAME` | `破甲论坛` | 站点名（健康检查/邮件等文案） |
| `ALLOWED_ORIGINS` | `*` | 允许跨域的前端来源，逗号分隔；**上线后务必收敛**为两个前端域名 |
| `PASSWORD_ITERATIONS` | `60000` | PBKDF2 迭代次数，代码限制在 10000–600000 |
| `ENVIRONMENT` | `production` | 本地为 `local`（允许 127.0.0.1 跨域） |

线上建议把 `ALLOWED_ORIGINS` 改成：

```toml
ALLOWED_ORIGINS = "https://<owner>.github.io,https://pojia.example.com"
```

---

## 4. 部署 Worker 并验证 API 🔑

```bash
# 4.1 部署（--config 指定 deploy/wrangler.toml，main 会解析为 ../backend/worker.mjs）
npx wrangler deploy --config deploy/wrangler.toml
```

输出会给出地址，形如 `https://pojia-api.<your-subdomain>.workers.dev`。

```bash
# 4.2 健康检查
curl -sS https://pojia-api.<your-subdomain>.workers.dev/api/health
# 预期：{"ok":true,"version":"1.0.0","time":"...","categories":7,"environment":"production"}

# 4.3 板块与站点快照
curl -sS https://pojia-api.<your-subdomain>.workers.dev/api/v1/categories
curl -sS "https://pojia-api.<your-subdomain>.workers.dev/api/v1/site?page=1&page_size=5"

# 4.4 CORS 预检（把 Origin 换成真实前端域名）
curl -sS -i -X OPTIONS https://pojia-api.<your-subdomain>.workers.dev/api/v1/site \
  -H "Origin: https://<owner>.github.io" \
  -H "Access-Control-Request-Method: GET"
# 预期：响应头包含 Access-Control-Allow-Origin: https://<owner>.github.io

# 4.5 写接口冒烟（注册 → 发帖 → 回复；返回 Bearer token）
curl -sS -X POST https://pojia-api.<your-subdomain>.workers.dev/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"deploytest","email":"deploytest@example.com","password":"DeployTest123!"}'
```

### 4.6 自定义域（可选）🔑

Workers 自定义域要求**该域名（zone）的 NS 已托管在同一个 Cloudflare 账号**：

1. Cloudflare Dashboard → Workers & Pages → `pojia-api` → Settings → Domains & Routes → Add → Custom domain；
2. 或取消 `deploy/wrangler.toml` 中 `routes` 的注释并重新 `deploy`；
3. 若域名 NS 不在 Cloudflare，只能继续使用 `*.workers.dev` 地址（API 仍可跨域调用）。

```bash
# 验证自定义域
curl -sS https://api.example.com/api/health
```

### 4.7 创建线上管理员 🔑

```bash
# 4.7.1 先用 API 注册一个普通账号（用户名小写后作为 username_lower）
# 4.7.2 直接把该账号提升为管理员
npx wrangler d1 execute pojia --remote --config deploy/wrangler.toml \
  --command "UPDATE users SET role='admin' WHERE username_lower='deploytest'"

# 4.7.3 验证：重新登录拿 token，调用站务复核接口应成功（而非 403）
```

> 本地开发无需手动改库：启动本地 API 时带上 `ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD`，会自动创建/更新管理员（见 README「本地运行」）。

---

## 5. GitHub Pages 前端（前端 A）🔑

仓库已包含 `.github/workflows/pages.yml`。

1. GitHub 仓库 → **Settings → Pages** → Build and deployment → **Source = GitHub Actions**；
2. **Settings → Secrets and variables → Actions → Variables** 新增（注意是 Variables，不是 Secrets）：

   | 名称 | 示例 | 说明 |
   |---|---|---|
   | `API_BASE` | `https://pojia-api.example.workers.dev` | 后端地址，无结尾斜杠、无 `/api` 后缀 |
   | `SITE_URL` | `https://<owner>.github.io/<repo>` | 项目站点；绑自定义域后如 `https://pojia.example.com` |

3. **Actions → Deploy static site to GitHub Pages → Run workflow**（或 push 到 `main`）。

Workflow 行为：checkout → setup-node 24 → 校验 Variables（缺失会以 `::error::` 明确失败）→ `node frontend/build.mjs`（`API_BASE`/`SITE_URL` 注入）→ upload-pages-artifact(`frontend/dist`) → deploy-pages。另有**每小时 cron** 重建（`17 * * * *`），把 API 中的新帖同步进静态站。

```bash
# 5.1 首页可访问（项目站点注意带仓库子路径）
curl -sS -o /dev/null -w "%{http_code}\n" https://<owner>.github.io/<repo>/
# 预期：200（首次发布可能需 1–2 分钟）

# 5.2 子路径资源与相对链接正确
curl -sS https://<owner>.github.io/<repo>/ | grep -o 'href="[^"]*app.css"' | head -n 1
# 预期：形如 href="./assets/app.css"（相对路径）或含 /<repo>/ 前缀

# 5.3 canonical 自引用（含仓库子路径）
curl -sS https://<owner>.github.io/<repo>/ | grep -o '<link rel="canonical"[^>]*>'
# 预期：<link rel="canonical" href="https://<owner>.github.io/<repo>/">

# 5.4 sitemap / robots / RSS
curl -sS https://<owner>.github.io/<repo>/sitemap.xml | grep -c '<loc>'
curl -sS https://<owner>.github.io/<repo>/robots.txt
curl -sS https://<owner>.github.io/<repo>/feed.xml | head -n 20

# 5.5 运行时配置中的 API 地址
curl -sS https://<owner>.github.io/<repo>/assets/config.js
# 预期：window.POJIA_CONFIG 中 apiBase 等于仓库 Variable API_BASE
```

---

## 6. Cloudflare Pages 前端（前端 B）🔑

同一仓库、同一份构建命令，仅 `SITE_URL` 不同：

1. Cloudflare Dashboard → Workers & Pages → **Create → Pages → Connect to Git**，选择本仓库；
2. Framework preset：**None**；Build command：`node frontend/build.mjs`；Build output directory：`frontend/dist`；
3. Environment variables（Production 与 Preview 都加）：

   | 名称 | 值 |
   |---|---|
   | `NODE_VERSION` | `24` |
   | `API_BASE` | `https://api.example.com` |
   | `SITE_URL` | `https://pojia.example.com`（自定义域）或 `https://pojia.pages.dev` |

4. 保存并部署 → 绑定自定义域（域名 NS 需托管在 Cloudflare）。

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://pojia.example.com/
curl -sS https://pojia.example.com/ | grep -o '<link rel="canonical"[^>]*>'
# 预期 canonical 指向 https://pojia.example.com/
```

> 两个前端的产物除域名相关字符串外完全一致；页面内部链接使用相对路径，因此 GitHub Pages 子路径与独立域名都能正常工作。

---

## 7. SEO 收录清单 🔑

构建期已自动产出（无需手工编辑）：

- [x] `sitemap.xml`（含 lastmod/changefreq/priority）
- [x] `<link rel="canonical">` 自引用
- [x] `robots.txt`（Disallow `/search/`、`/login/`、`/register/`、`/new/`、`/404.html`，并声明 Sitemap）
- [x] `feed.xml`（RSS 2.0，最新 30 个主题）
- [x] JSON-LD 结构化数据（见生成 HTML 的 `<script type="application/ld+json">`）
- [x] `.nojekyll`（GitHub Pages 发布资源目录所需）

线上必做：

1. **提交 sitemap**：Google Search Console / Bing Webmaster Tools → Sitemaps → 提交 `https://<站点>/sitemap.xml`；百度搜索资源平台提交同一地址。
2. **验证抓取**：Search Console → URL 检查 → 粘贴一个主题详情页 URL → 请求编入索引。
3. **检查 canonical 不被改写**：`curl -sS <页面> | grep canonical` 必须指向自身正式域名，不能出现 `127.0.0.1`。
4. **检查 robots 未误伤**：`curl -sS <站点>/robots.txt`，确认 `Allow: /` 且仅 Disallow 页面符合预期。
5. **静态站收录节奏**：GitHub Pages / Cloudflare Pages 都没有服务端渲染，**新帖只有在下一次构建后才进入 sitemap/RSS/HTML**。GitHub Pages 已配每小时 cron；Cloudflare Pages 需在 Dashboard 配置 Deploy Hook + 外部定时器（或接受手动/推送重建）。
6. **RSS 订阅有效性**：RSS 阅读器或 W3C Feed Validator 校验 `feed.xml`。
7. **结构化数据**：Search Console → 增强功能/富媒体结果，确认 JSON-LD 无报错。
8. **移动端/性能**：PageSpeed Insights 抽查首页与主题页。

```bash
# sitemap 中 URL 数量与首页数量一致性粗检
curl -sS https://pojia.example.com/sitemap.xml | grep -c '<loc>'

# 抽查 sitemap 中每个 URL 返回 200（示例取前 5 个）
curl -sS https://pojia.example.com/sitemap.xml | grep -o '<loc>[^<]*' | sed 's/<loc>//' | head -n 5 | while read -r u; do
  printf '%s -> ' "$u"; curl -sS -o /dev/null -w "%{http_code}\n" "$u";
done
```

---

## 8. 回滚与排错 🔑

```bash
# 查看最近的部署
npx wrangler deployments list --config deploy/wrangler.toml

# 回滚到上一个版本
npx wrangler rollback --config deploy/wrangler.toml

# 实时日志（排查 500/认证问题）
npx wrangler tail pojia-api --config deploy/wrangler.toml

# 检查当前线上变量（vars 可见，secret 只显示名字）
npx wrangler secret list --config deploy/wrangler.toml
```

常见问题：

| 现象 | 原因 | 处理 |
|---|---|---|
| `d1 migrations apply` 报 database_id 无效 | 未替换 `REPLACE_WITH_D1_ID` | 用 `wrangler d1 create pojia` 输出的 id 更新配置 |
| `/api/health` 返回 500 | D1 未建表 | 先执行第 2 步迁移，`categories` 表必须存在 |
| 前端控制台 CORS 报错 | `ALLOWED_ORIGINS` 未含前端域名 | 更新 `[vars]` 后重新 `deploy`（vars 变更需重新部署） |
| 登录/注册 401 或 500 | 未设置 `APP_SECRET` | 执行 `wrangler secret put APP_SECRET` |
| 页面资源 404 | `SITE_URL` 缺少仓库子路径 | 项目站点必须写成 `https://<owner>.github.io/<repo>` |
| 发帖后页面没变化 | 静态站未重建 | 等下一小时 cron，或手动 Run workflow / 重新部署 Pages |

---

## 9. 验收责任划分

| 步骤 | 可本地验证 | 需要线上凭据 |
|---|---|---|
| 0. 本地预检 / 迁移 SQL / 构建 / 预览 | ✅ | — |
| 1. D1 create + 配置 id | — | 🔑 |
| 2. migrations apply + 数据检查 | — | 🔑 |
| 3. APP_SECRET / vars | — | 🔑 |
| 4. Worker deploy / health / CORS / 自定义域 | — | 🔑 |
| 4.7 管理员提升 | — | 🔑 |
| 5. GitHub Pages 配置与发布 | — | 🔑（GitHub 仓库权限） |
| 6. Cloudflare Pages 配置与发布 | — | 🔑 |
| 7. SEO 提交与线上抓取验证 | — | 🔑（Search Console 等） |
