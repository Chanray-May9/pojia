# 破甲论坛 · 架构说明（v2）

> 目标：**后端统一 Cloudflare，前端两份完全相同的静态站（GitHub Pages / Cloudflare 各一份，仅域名不同）**，同时保持搜索引擎可索引。

## 1. 总体结构

```
用户浏览器
  ├─ 前端 A：GitHub Pages 静态站（如 https://<user>.github.io/pojia/）
  └─ 前端 B：Cloudflare Pages 静态站（如 https://pojia.example.com）
        │  同一份构建产物、同一套代码，仅域名不同
        └── HTTPS + Bearer Token ──▶ Cloudflare Worker API（如 https://api.example.com）
                                        └── Cloudflare D1（SQLite）
```

- **后端**：Cloudflare Worker（ES Module `fetch` 处理器）+ D1 数据库。同时提供**本地运行适配器**（Node 24 + `node:sqlite`），本地跑的就是同一份 Worker 代码，便于开发和自动化测试。
- **前端**：构建期静态生成（SSG）。公开页面在构建时直接产出完整 HTML（标题、正文、回复、JSON-LD、canonical、sitemap、RSS），因此**不依赖 JS 也能被搜索引擎收录**；交互能力（登录、发帖、回复、搜索）由 `client/app.js` 通过 API 增强。
- **认证**：无 Cookie、跨域友好。登录返回随机 Bearer Token（服务端只存 SHA-256 摘要），前端存 `localStorage`，写操作带 `Authorization: Bearer <token>`。因此不需要 CORS credentials、也不需要 CSRF token。
- **两份前端一致性**：同一构建命令 `node frontend/build.mjs`，仅通过环境变量区分 `SITE_URL`（自身域名）与 `API_BASE`（后端地址）。两份产物逐字节一致，唯一差异是域名相关字符串；页面内部链接全部使用**相对路径**，因此 GitHub Pages 的项目子路径（`/pojia/`）与独立域名都能正常工作。

## 2. 目录

```
pojia-forum/
├─ shared/
│  ├─ markdown.mjs        # 安全 Markdown 渲染（先转义，再白名单转换）
│  └─ models.mjs          # 目标模型目录（前后端共用）
├─ backend/
│  ├─ worker.mjs          # Cloudflare Worker 入口
│  ├─ app.mjs             # 路由 + 全部 API 处理（Web 标准 Request/Response）
│  ├─ db.mjs              # D1 兼容的数据库抽象（D1 或本地 sqlite 驱动）
│  ├─ local-db.mjs        # node:sqlite 的 D1 兼容 shim
│  ├─ local-server.mjs    # 本地开发/测试用的 Node HTTP 适配器
│  ├─ auth.mjs            # PBKDF2 口令哈希、Token 会话、限流
│  └─ schema.sql          # D1 建表语句（wrangler d1 migrations 使用）
├─ frontend/
│  ├─ build.mjs           # SSG 构建入口（生成 dist/）
│  ├─ lib/                # 布局与页面模板
│  ├─ client/app.js       # 渐进增强脚本
│  └─ public/             # 静态资源（app.css、favicon 等）
├─ deploy/
│  ├─ wrangler.toml       # Worker + D1 绑定
│  └─ github-pages.yml    # GitHub Actions：构建并发布到 Pages
└─ tests/                 # 自动化验收（QA 维护）
```

## 3. API 契约（版本前缀 `/api/v1`）

所有响应 `Content-Type: application/json`；错误统一 `{ "error": "code", "message": "中文说明", "fields": {...}? }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查：`{ok,version,time}` |
| GET | `/api/v1/site` | **SSG 用公开快照**：`{generated_at, stats, categories[], threads[]}`（threads 含正文与回复，分页拉取） |
| GET | `/api/v1/categories` | 板块列表（含主题数） |`n| POST | `/api/v1/categories` | Bearer；`{name,description}` → `201 {category,redirect:"/c/<slug>/"}`，任何登录用户可自建板块（每小时 5 个） |
| GET | `/api/v1/threads?category=&page=&page_size=` | 主题列表（不含正文全文，含摘要、模型标签、验证等级） |
| GET | `/api/v1/threads/:id` | 主题详情 + 回复 |
| GET | `/api/v1/search?q=&page=` | 全文搜索（标题/正文/回复，LIKE 实现） |
| POST | `/api/v1/auth/register` | `{username,email,password}` → `201 {token,user,redirect:"/"}` |
| POST | `/api/v1/auth/login` | `{login,password}` → `200 {token,user,redirect:"/"}` |
| POST | `/api/v1/auth/logout` | Bearer → `200 {ok:true}` |
| GET | `/api/v1/auth/me` | Bearer → `{user}` |
| POST | `/api/v1/threads` | **Bearer 可选**（未登录以「匿名用户」发布，按 IP 限流）；`{category,title,body,models:[],model_custom,verification}` → `201 {thread,redirect:"/t/<id>-<slug>/"}` |
| POST | `/api/v1/threads/:id/replies` | **Bearer 可选**（同上匿名）；`{body}` → `201 {post,redirect:"/t/<id>-<slug>/#p<postId>"}` |
| POST | `/api/v1/threads/:id/report` | Bearer；`{reason}` → `200 {ok:true}` |

### 模型标注（新增需求 1）
- 板块不再写死：7 个初始板块之外，任何登录用户都可通过 `POST /api/v1/categories` 或站点 `/category/new/` 页面自建板块；静态站下一次构建后进入导航、sitemap 与列表。`n- `shared/models.mjs` 提供固定目录：`{id, label, vendor}`，前端渲染为多选（最多 3 个），并允许 `model_custom` 自由文本补充。
- 帖子保存 `models`（逗号分隔的 id）、`model_custom`；列表页与详情页显示模型标签，未标注则不显示（降级正常）。

### 实机验证（新增需求 2）
三种状态，防止"误标"：
- `none`：未标注（默认）。
- `self`：**作者自报**"实机验证"，UI 文案为「实机验证 · 作者自述」，附灰蓝色徽标。
- `admin`：**站务复核通过**，UI 文案为「实机验证 · 已复核」，附青铜徽标。
- 只有作者能提交 `self`；`admin` 只能由管理员通过 API（`POST /api/v1/threads/:id/verify`，需 `role=admin`）设置。前端在详情页显示复核时间与复核人（可选）。
- 构建期的 JSON-LD 会输出 `additionalProperty: [{name:"实机验证", value:"self|admin"}]`，便于结构化检索。

## 4. 前端路由（静态产物，全部相对链接）

| 路径 | 文件 | 索引 |
|---|---|---|
| `/` | `index.html` | index |
| `/page/<n>/` | 分页 | index |
| `/category/` | 板块总览 | index |
| `/c/<slug>/`、`/c/<slug>/page/<n>/` | 板块 | index |
| `/latest/`、`/latest/page/<n>/` | 最新 | index |
| `/t/<id>-<slug>/` | 主题详情 | index |
| `/u/<name>/` | 用户主页 | index |
| `/about/` | 静态页 | index |
| `/search/` | 搜索页 | `noindex,follow` |
| `/new/` | 发帖页 | `noindex,nofollow` |`n| `/category/new/` | 新建板块页 | `noindex,nofollow` |
| `/login/`、`/register/` | 认证页 | `noindex,nofollow` |
| `/404.html` | 404 | noindex |

每个可索引页面自带 `sitemap.xml` + `robots.txt` + `feed.xml`（构建期生成）。

## 5. 本地开发与验收

```bash
# 1) 安装 Node 24+（无需 npm install，零依赖）
# 2) 启动本地后端（Worker 代码 + node:sqlite）
node backend/local-server.mjs            # 默认 http://127.0.0.1:4400
# 3) 构建前端（默认从本地 API 拉取快照）
node frontend/build.mjs --api http://127.0.0.1:4400 --site http://127.0.0.1:4401
# 4) 预览静态站
node frontend/serve.mjs                  # http://127.0.0.1:4401
```

## 6. 线上部署

1. **D1**：`wrangler d1 create pojia && wrangler d1 migrations apply pojia --remote`
2. **Worker**：`wrangler deploy`（绑定 D1、`APP_SECRET`、`ALLOWED_ORIGINS`）
3. **GitHub Pages**：`.github/workflows/pages.yml` 定时（每小时）+ 手动触发，构建时 `API_BASE=https://api.example.com SITE_URL=https://<user>.github.io/pojia` 生成并发布 `frontend/dist`
4. **Cloudflare Pages**：同一仓库、同一构建命令，`SITE_URL=https://pojia.example.com`
5. 域名与 TLS 全部交给 Cloudflare；GitHub Pages 侧自定义域名可选。

> 收录节奏：每次构建都会更新 sitemap 和 RSS；建议在 Search Console / Bing 提交 sitemap，并在每次发布后请求重新抓取。
