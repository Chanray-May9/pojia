# 破甲论坛 · 本地一键预览（Windows PowerShell）
# 用法：右键“使用 PowerShell 运行”，或在终端执行：
#   powershell -ExecutionPolicy Bypass -File .\start-local.ps1

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Set-Location $PSScriptRoot

$env:PORT = '4400'
$env:DB_PATH = 'data/demo.db'
$env:SITE_URL = 'http://127.0.0.1:4401'
$env:ADMIN_USERNAME = 'admin'
$env:ADMIN_EMAIL = 'admin@example.com'
$env:ADMIN_PASSWORD = 'AdminPass123!'

Write-Host '[1/3] 启动本地 API（端口 4400）...' -ForegroundColor Cyan
$api = Start-Process -FilePath 'node' -ArgumentList 'backend/local-server.mjs' -PassThru -NoNewWindow
Start-Sleep -Seconds 2

# 首次运行时写入演示数据（已有帖子则跳过）
$threads = 0
try {
  $site = Invoke-RestMethod 'http://127.0.0.1:4400/api/v1/site?page_size=1'
  $threads = [int]$site.stats.threads
} catch {
  Write-Host 'API 启动失败，请确认已安装 Node 22+ 且在项目根目录运行。' -ForegroundColor Red
  Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
  exit 1
}
if ($threads -eq 0) {
  Write-Host '     首次运行，写入演示数据...' -ForegroundColor DarkGray
  node scripts/demo-data.mjs --api http://127.0.0.1:4400 | Out-Host
}

Write-Host '[2/3] 构建静态站...' -ForegroundColor Cyan
node frontend/build.mjs --api http://127.0.0.1:4400 --site http://127.0.0.1:4401 | Select-Object -Last 6 | Out-Host

Write-Host '[3/3] 启动静态预览（端口 4401）...' -ForegroundColor Cyan
$web = Start-Process -FilePath 'node' -ArgumentList 'frontend/serve.mjs','--port','4401' -PassThru -NoNewWindow
Start-Sleep -Seconds 1

Write-Host ''
Write-Host '  打开浏览器访问： http://127.0.0.1:4401' -ForegroundColor Green
Write-Host '  管理员账号：admin / AdminPass123!（可选登录，不登录也能发帖回帖）' -ForegroundColor Green
Write-Host '  停止服务：在本窗口按 Ctrl+C' -ForegroundColor DarkGray
Write-Host ''
Start-Process 'http://127.0.0.1:4401'

try {
  while ($true) { Start-Sleep -Seconds 3600 }
} finally {
  Write-Host '正在停止服务...' -ForegroundColor DarkGray
  Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
}
