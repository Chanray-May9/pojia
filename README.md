# 破甲论坛 · POJIA

> **AI 越狱与提示词攻击实战社区·攻击方视角** —— Cloudflare Worker + D1 后端，同一份代码产出两份完全相同的静态前端（GitHub Pages / Cloudflare Pages）。

破甲论坛是一个面向安全研究者与防御方的技术社区，聚焦大模型越狱路径复盘、提示词注入攻防、红队评估方法、防御与对齐实践，以及对厂商的模型漏洞披露流程。站点采用「静态前端 + Serverless API」架构：公开内容在构建期静态生成（SSG），不依赖 JS 也能被搜索引擎完整收录；登录、发帖、回复、搜索等交互由浏览器调用 Worker API 渐进增强。


# 下面的”合规声明“是AI写的，请忽略，AI太注重道德和法律，这也是我们为什么要破甲的原因。

## 合规声明（请先阅读）

- 本项目及站点内容**仅限授权范围内的安全研究、红队评估与防御建设**。请只对自己拥有或已获书面授权的模型、系统与数据进行测试。#下面的”合规声明“是AI写的，请忽略，AI太注重道德和法律，这也是我们为什么要破甲的原因。
- **禁止**将本站内容用于攻击他人系统、侵害他人权益、绕过平台安全机制、批量滥用模型服务或任何违法用途。
- 站内只收**真打实测、能复现**的记录；「模型漏洞」板块用于记录漏洞本身与影响面。
- 用户发布的内容由发布者自行负责；站务可对违规内容做隐藏、锁定或删除处理。
- 联系方式示例：`security@example.com`（部署时请替换为真实联系方式）。

---

## 架构

```
                     ┌──────────────────────────────┐
   用户浏览器 ──────▶ │ 前端 A：GitHub Pages 静态站   │
                     │ https://<owner>.github.io/repo│
                     └──────────────┬───────────────┘
                                    │
                     ┌──────────────▼───────────────┐
                     │ 前端 B：Cloudflare Pages 静态站│
                     │ https://pojia.example.com     │
                     └──────────────┬───────────────┘
                                    │  同一份构建产物（仅域名不同）
                                    │  HTTPS + Bearer Token（无 Cookie）
                     ┌──────────────▼───────────────┐
                     │ Cloudflare Worker API         │
                     │ https://api.example.com       │
                     │ backend/worker.mjs → app.mjs  │
                     └──────────────┬───────────────┘
                                    │
                     ┌──────────────▼───────────────┐
                     │ Cloudflare D1（SQLite）       │
                     │ users/sessions/categories/... │
                     └──────────────────────────────┘

本地开发：node backend/local-server.mjs 把同一份 Worker 代码
         跑在 Node 24 + node:sqlite 上（端口 4400），
         前端构建产物用 node frontend/serve.mjs 预览（端口 4401）。
```

设计要点：

- **后端统一 Cloudflare**：Worker（Web 标准 `Request`/`Response`）+ D1。本地用 `node:sqlite` 实现同接口 shim，本地跑的就是线上同一份代码。
- **前端 SSG**：`frontend/build.mjs` 在构建时拉取 API 快照，直接产出完整 HTML（标题、正文、回复、canonical、JSON-LD、sitemap、RSS）。交互能力由 `frontend/public/app.js` 渐进增强（构建时复制到 `frontend/dist/assets/app.js`）。
- **双前端一致**：同一命令、同一产物；`SITE_URL`/`API_BASE` 两个环境变量区分站点与后端。页面内部链接全部相对路径，因此 GitHub Pages 的项目子路径与独立域名都能工作。
- **无 Cookie 认证**：登录返回随机 Bearer Token（服务端只存 SHA-256 摘要），前端存 `localStorage`；写操作带 `Authorization: Bearer <token>`。因此无需 CORS credentials，也无需 CSRF token。

详细契约与路由见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；线上部署逐步清单见 [`docs/deploy.md`](docs/deploy.md)。

---

## 界面预览

截图来自本地构建产物（`docs/screenshots/`），无需启动服务即可先看界面：

| 首页（桌面） | 主题详情（桌面） |
|---|---|
| ![首页 · 桌面](docs/screenshots/home-desktop.png) | ![主题详情 · 桌面](docs/screenshots/thread-desktop.png) |

![首页 · 移动端](docs/screenshots/home-mobile.png)

---

## 目录结构

```
pojia-forum/
├─ ARCHITECTURE.md          # 架构 v2 与 API 契约
├─ package.json             # 零 npm 依赖；仅 scripts（start/preview/build/demo/test）
├─ backend/
│  ├─ worker.mjs            # Cloudflare Worker 入口（wrangler main）
│  ├─ app.mjs               # 路由 + 全部 API 处理
│  ├─ db.mjs                # D1 兼容数据库抽象 + 建表/种子
│  ├─ local-db.mjs          # node:sqlite 的 D1 兼容 shim
│  ├─ local-server.mjs      # 本地 Node HTTP 适配器（端口 4400）
│  ├─ auth.mjs              # PBKDF2 哈希、Bearer 会话、限流
│  └─ schema.sql            # D1 建表语句（与 migrations 一致）
├─ frontend/
│  ├─ build.mjs             # SSG 构建入口 → frontend/dist/
│  ├─ lib/                  # 布局与页面模板（canonical/JSON-LD/sitemap/RSS）
│  ├─ public/               # 静态资源：app.css、app.js（渐进增强脚本）、favicon、og 图
│  └─ serve.mjs             # 静态预览服务器（端口 4401）
├─ shared/                  # 前后端共用：品牌/板块/模型目录/Markdown
├─ deploy/
│  ├─ wrangler.toml         # Worker + D1 绑定 + vars
│  └─ migrations/           # D1 迁移（0001_init.sql：建表 + 板块种子）
├─ .github/workflows/pages.yml  # GitHub Pages 构建/发布（push + 每小时 + 手动）
├─ docs/deploy.md           # 线上部署逐条清单（含验证命令）
├─ scripts/demo-data.mjs    # 本地演示数据
└─ tests/                   # 自动化验收（node --test）
```

---

## 本地运行（零依赖）

要求 **Node.js 24+**（`node:sqlite` 需要）。**无需 `npm install`**（项目没有任何 npm 依赖）。

```bash
# 0) 版本确认
node -v

# 1) 启动本地 API（同一份 Worker 代码 + node:sqlite），默认 http://127.0.0.1:4400
node backend/local-server.mjs
#    等价：npm start
#    自定义端口/数据库：PORT=4400 DB_PATH=data/local.db node backend/local-server.mjs

# 2) 可选：写入演示数据（需保持上一步运行）
node scripts/demo-data.mjs --api http://127.0.0.1:4400
#    等价：npm run demo

# 3) 构建静态站到 frontend/dist（从上面的 API 拉取快照）
node frontend/build.mjs --api http://127.0.0.1:4400 --site http://127.0.0.1:4401
#    等价：npm run build
#    也可用环境变量：API_BASE=... SITE_URL=... node frontend/build.mjs

# 4) 预览静态站，浏览器打开 http://127.0.0.1:4401
node frontend/serve.mjs
#    等价：npm run preview
```

验证本地 API：

```bash
curl -sS http://127.0.0.1:4400/api/health
# {"ok":true,"version":"1.0.0","time":"...","categories":7,"environment":"local"}

curl -sS http://127.0.0.1:4400/api/v1/categories
```

> Windows PowerShell 中 `curl` 是内置别名，请用 `curl.exe -sS ...` 或 `Invoke-RestMethod`。
> 构建也可离线：`node frontend/build.mjs --data snapshot.json`（快照文件由 `GET /api/v1/site` 导出）。

### 管理员账号（本地）

启动本地 API 时提供以下环境变量，会自动创建/更新管理员（`role=admin`）：

```bash
ADMIN_USERNAME=admin ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='ChangeMe123!' node backend/local-server.mjs
```

PowerShell：

```powershell
$env:ADMIN_USERNAME='admin'; $env:ADMIN_EMAIL='admin@example.com'; $env:ADMIN_PASSWORD='ChangeMe123!'; node backend/local-server.mjs
```

演示数据脚本也支持 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，会额外演示一次「站务复核实机验证」：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='ChangeMe123!' node scripts/demo-data.mjs --api http://127.0.0.1:4400
```

### 测试

```bash
node --test tests/deploy-config.test.mjs   # 部署配置静态验收
node --test                                # 全部测试（等价 npm test）
```

---

## API 契约摘要

完整契约（字段、错误格式、状态码、前端路由）见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。所有响应为 JSON；错误统一 `{ "error": "code", "message": "中文说明", "fields": {...}? }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 `{ok,version,time,categories,environment}` |
| GET | `/api/v1/site` | SSG 公开快照（板块 + 主题 + 回复 + 用户，分页拉取） |
| GET | `/api/v1/categories` | 板块列表（含主题数/回复数） |
| GET | `/api/v1/threads?category=&page=&page_size=` | 主题列表 |
| GET | `/api/v1/threads/:id` | 主题详情 + 回复 |
| GET | `/api/v1/search?q=&page=` | 全文搜索（标题/正文/回复） |
| GET | `/api/v1/users/:name` | 用户主页数据 |
| GET | `/api/v1/models` | 模型目录 + 验证状态枚举 |
| POST | `/api/v1/auth/register` | `{username,email,password}` → `201 {token,user,redirect}` |
| POST | `/api/v1/auth/login` | `{login,password}` → `200 {token,user,redirect}` |
| POST | `/api/v1/auth/logout` | Bearer → `{ok:true}` |
| GET | `/api/v1/auth/me` | Bearer → `{user}` |
| POST | `/api/v1/threads` | Bearer；`{category,title,body,models[],model_custom,verification}` |
| POST | `/api/v1/threads/:id/replies` | Bearer；`{body}` |
| POST | `/api/v1/threads/:id/verify` | Bearer + `role=admin`；`{verification:"admin"|"none"}` |
| POST | `/api/v1/threads/:id/report` | Bearer；`{reason}` |
| POST | `/api/v1/threads/:id/view` | 浏览量自增（公开） |

模型标注：`models` 为逗号分隔的模型 id（最多 3 个，见 `shared/models.mjs`），`model_custom` 为自由文本补充。
实机验证：`none`（默认）/ `self`（作者自述）/ `admin`（站务复核），只有管理员能设置 `admin`。

---

## Cloudflare 部署

> 需要 Cloudflare 账号与线上凭据，**无法本地验证**。逐步清单与验证命令见 [`docs/deploy.md`](docs/deploy.md)。

```bash
# 1) D1：创建数据库（输出里的 database_id 填入 deploy/wrangler.toml）
npx wrangler login
npx wrangler d1 create pojia

# 2) 应用迁移（建表 + 7 个初始板块；站点上线后任何登录用户都可通过「＋ 新建板块」自建板块）
npx wrangler d1 migrations apply pojia --remote --config deploy/wrangler.toml

# 3) Worker Secret（APP_SECRET 绝不写进仓库）
npx wrangler secret put APP_SECRET --config deploy/wrangler.toml

# 4) 部署 Worker（main = ../backend/worker.mjs）
npx wrangler deploy --config deploy/wrangler.toml

# 5) 验证
curl -sS https://pojia-api.<your-subdomain>.workers.dev/api/health
npx wrangler d1 execute pojia --remote --config deploy/wrangler.toml \
  --command "SELECT COUNT(*) AS categories FROM categories"   # 预期 7
```

`deploy/wrangler.toml` 关键项：

```toml
name = "pojia-api"
main = "../backend/worker.mjs"        # 相对 deploy/wrangler.toml 解析
compatibility_date = "2026-06-01"

[[d1_databases]]
binding = "DB"
database_name = "pojia"
database_id = "REPLACE_WITH_D1_ID"    # ← wrangler d1 create 的输出
migrations_dir = "migrations"

[vars]
SITE_NAME = "破甲论坛"
ALLOWED_ORIGINS = "*"                 # 上线后收敛为两个前端域名
PASSWORD_ITERATIONS = "60000"
ENVIRONMENT = "production"
```

**自定义域名要求**：Workers 自定义域（如 `api.example.com`）要求该域名的 **NS 托管在同一个 Cloudflare 账号**；NS 不在 Cloudflare 时继续使用 `*.workers.dev` 地址（API 跨域调用不受影响，只需把前端域名加入 `ALLOWED_ORIGINS`）。

**Wrangler 不是项目依赖**：请用全局 `wrangler` 或 `npx wrangler`（临时下载），不要把它写进 `package.json`（保持零 npm 依赖）。配置文件在 `deploy/` 目录，所有命令都要带 `--config deploy/wrangler.toml`。

---

## 双前端：Cloudflare Pages + GitHub Pages

两个前端是**同一份构建产物、同一套代码**，仅域名不同；页面内部链接全部相对路径，因此子路径部署与独立域名都可正常工作。

### GitHub Pages（前端 A，项目子路径）

仓库已带 `.github/workflows/pages.yml`：

1. 仓库 **Settings → Pages → Source = GitHub Actions**；
2. **Settings → Secrets and variables → Actions → Variables** 新增：
   - `API_BASE` = `https://pojia-api.<your-subdomain>.workers.dev`（或 `https://api.example.com`）
   - `SITE_URL` = `https://<owner>.github.io/<repo>`（项目站点必须带仓库子路径；无结尾斜杠）
3. push 到 `main` / 手动 Run workflow / 每小时 cron 自动重建。

Workflow 会校验两个 Variables（缺失或格式非法时以明确错误失败），然后执行 `node frontend/build.mjs`，上传 `frontend/dist` 并用官方 Pages actions 发布。

### Cloudflare Pages（前端 B，独立域名）

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git；
2. Build command：`node frontend/build.mjs`；Build output directory：`frontend/dist`；
3. 环境变量：`NODE_VERSION=24`、`API_BASE=https://api.example.com`、`SITE_URL=https://pojia.example.com`；
4. 保存部署 → 绑定自定义域（域名 NS 需托管在 Cloudflare）。

> 由于是纯静态站，**新帖只有在重新构建后才会出现在 HTML/sitemap/RSS 中**。GitHub Pages 已配每小时 cron；Cloudflare Pages 需用 Deploy Hook + 外部定时器，或接受推送/手动重建。

---

## SEO 收录清单

构建期已自动生成，无需手工维护：

- [x] `sitemap.xml`（含 `lastmod`/`changefreq`/`priority`）
- [x] 每页 `<link rel="canonical">` 自引用（正确带子路径/域名）
- [x] `robots.txt`（允许抓取公开内容；Disallow `/search/`、`/login/`、`/register/`、`/new/`、`/404.html`；声明 Sitemap）
- [x] RSS：`feed.xml`（RSS 2.0，最新 30 个主题）
- [x] JSON-LD 结构化数据（构建期写入页面）
- [x] `.nojekyll`（GitHub Pages 发布所需）
- [x] 非公开页面使用 `noindex`；搜索页 `noindex,follow`

上线后必做：

1. **提交 sitemap**：Google Search Console / Bing Webmaster Tools / 百度搜索资源平台提交 `https://<站点>/sitemap.xml`；
2. **请求收录**：用 Search Console 的 URL 检查对首页与代表性主题页请求编入索引；
3. **自检 canonical**：`curl -sS <页面> | grep canonical`，必须指向自身正式域名（不能是 127.0.0.1 或错误子路径）；
4. **确认 robots 不误伤**：仅搜索/登录/注册/发帖页与 404 被 Disallow；
5. **定时重建**：静态站不会自动出现新帖，必须依赖每小时 cron（GitHub Pages 已配）或 Deploy Hook 重建，否则新帖无法被收录；
6. **RSS/JSON-LD 校验**：用 W3C Feed Validator 与 Search Console 富媒体结果检查；
7. **首次收录需要时间**：新站通常数天到数周，请勿频繁改域名/canonical。

---

## 认证与安全

- **Bearer Token**：登录返回随机 token（32 字节 base64url），服务端只存 SHA-256 摘要（`sessions.token_hash`），有效期 30 天；前端存 `localStorage`，请求带 `Authorization: Bearer <token>`。
- **PBKDF2**：SHA-256，默认 **60000 次**迭代（`PASSWORD_ITERATIONS`，代码限制 10000–600000）。迭代越高越抗爆破，但更耗 CPU。
- **Workers CPU 限制**：免费计划单请求 CPU 时间很短，高迭代 PBKDF2 容易触发 `1102`/超时；生产建议使用 **Workers Paid**（更高 CPU 上限）后再把 `PASSWORD_ITERATIONS` 上调（如 150000+）。
- **无 Cookie**：不存在 CSRF（无自动携带凭据），也不需要 `Access-Control-Allow-Credentials`；CORS 由 `ALLOWED_ORIGINS` 白名单控制，上线后不要保留 `*`。
- **登录限流**：`login_attempts` 表按 IP/账号记录失败尝试，超限返回 429。
- **敏感配置**：`APP_SECRET` 只能通过 `wrangler secret put` 注入；仓库内不得出现真实密钥（`.gitignore` 已忽略数据库、构建产物与 Wrangler 状态）。
- **XSS**：正文 Markdown 先转义再做白名单转换（`shared/markdown.mjs`）；模板输出统一转义。

---

## FAQ

**Q：GitHub Pages 能跑论坛吗？**
不能。GitHub Pages 只托管静态文件，是本站的**静态镜像**：公开内容来自构建期快照，登录/发帖/回复/搜索全部调用 Cloudflare Worker API。没有 Worker，页面看得到但无法交互。

**Q：GitHub Pages 项目子路径（`/repo/`）下链接会坏吗？**
不会。`SITE_URL` 带子路径时，构建脚本会把 pathname 作为 base path；页面内部链接使用相对路径，资源/canonical/sitemap/robots 都会带正确前缀。只需确保 `SITE_URL=https://<owner>.github.io/<repo>`（无结尾斜杠）。

**Q：D1 的「本地」和「远程」怎么区分？**
`wrangler d1 ... --local` 使用 `.wrangler/` 下的本地 SQLite 模拟（适合预演迁移，不产生云费用）；`--remote` 操作真实 D1。而 `node backend/local-server.mjs` 用的是 `data/local.db`（node:sqlite），三者互不影响。

**Q：Cloudflare 免费额度够用吗？**
小流量够用：Workers 免费计划有每日请求数上限，D1 免费计划有存储/读行/写行配额，Pages 静态请求免费。具体数值会调整，以 Cloudflare 官方 Pricing 页为准。**PBKDF2 口令哈希较耗 CPU，登录频繁时建议升级 Workers Paid**。

**Q：为什么不用 Cookie / 为什么没有 CSRF token？**
认证走 `Authorization` 头而不是 Cookie，浏览器不会自动携带，天然免疫 CSRF；代价是 token 存在 `localStorage`，XSS 防护必须严格（本站 Markdown 已做转义白名单）。

**Q：为什么没有 `npm install`？**
项目刻意保持零 npm 依赖：后端只用 Web 标准 + `node:sqlite`，前端是手写 SSG。部署工具 `wrangler` 用全局安装或 `npx` 临时调用，不进入 `package.json`。

**Q：改了代码后线上要做什么？**
后端改动：`npx wrangler deploy --config deploy/wrangler.toml`；前端/模板/样式改动：触发 Pages 构建（push 自动，或手动 Run workflow）。只改 `[vars]` 也需要重新 `deploy` 才生效。

**Q：本地构建提示连不上 API？**
先确认 `node backend/local-server.mjs` 已在 4400 端口运行；或改用离线快照 `node frontend/build.mjs --data snapshot.json`。构建默认 `API_BASE=http://127.0.0.1:4400`、`SITE_URL=http://127.0.0.1:4401`。

---

## 许可与致谢

仅用于安全研究与教育目的。部署前请自行确认所在地法律法规与目标平台条款；站点名、联系方式与示例域名均为占位符，请替换后再上线。
