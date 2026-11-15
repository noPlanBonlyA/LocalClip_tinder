# Clip Tinder (swiper) launcher for Windows: runs next to LocalClip on the same PC.
#   - installs npm deps on first run, creates .env from .env.example;
#   - starts the swiper server (http://127.0.0.1:3200);
#   - opens it to the internet with Cloudflare Tunnel so phones can reach it:
#       CLOUDFLARE_TUNNEL_TOKEN in swiper\.env -> your permanent named tunnel (recommended);
#       otherwise a free "quick tunnel" with a random https://*.trycloudflare.com address (changes every start).
# Close the window (or Ctrl+C) to stop.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Test-Cmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }

if (-not (Test-Cmd node)) { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements; Update-Path }
if (-not (Test-Cmd cloudflared)) { winget install -e --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements; Update-Path }

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "Создан swiper\.env — заполните его (APP_PASSWORD, GOOGLE_*, CRM_*) и запустите снова. См. swiper\README.md" -ForegroundColor Yellow
    notepad .env
    exit 1
}
if (-not (Test-Path node_modules)) { npm install --omit=dev }

$port = 3200
foreach ($line in Get-Content .env) {
    if ($line -match '^\s*PORT\s*=\s*(\d+)') { $port = [int]$Matches[1] }
    if ($line -match '^\s*CLOUDFLARE_TUNNEL_TOKEN\s*=\s*(.+)$') { $tunnelToken = $Matches[1].Trim().Trim('"') }
}

New-Item -ItemType Directory -Force data | Out-Null
$server = Start-Process node -ArgumentList "src/server.js" -NoNewWindow -PassThru
try {
    Start-Sleep -Seconds 2
    Write-Host "Свайпер: http://127.0.0.1:$port" -ForegroundColor Green
    if ($tunnelToken) {
        Write-Host "Туннель Cloudflare (постоянный адрес из настроек туннеля)..." -ForegroundColor Green
        cloudflared tunnel --no-autoupdate run --token $tunnelToken
    } else {
        Write-Host "Быстрый туннель: ищите строку https://....trycloudflare.com ниже — это ссылка для телефона." -ForegroundColor Green
        cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$port"
    }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
