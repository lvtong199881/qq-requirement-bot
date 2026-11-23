# 隧道守护：让 cloudflared 一直在跑，域名换了自动发布到发现通道。
#
# 为什么存在：免费版 trycloudflare 的 quick tunnel 空闲几分钟就被
# Cloudflare 回收（报 530 / Tunnel not found），cloudflared 进程自己
# 不会重连。这个脚本循环盯着进程：挂了就重启，新域名一出现就调
# src/endpoint-publisher.js 发到发现通道（Gitee/GitHub raw 均可），
# App 断链时拉它自愈。
#
# 用法：
#   powershell -File scripts\tunnel-keepalive.ps1
# 常驻：注册计划任务（开机/断电自启），见 docs/CONFIG.md 隧道段。

param(
    [int]$TargetPort = 7881,
    [string]$Cloudflared = "$PSScriptRoot\..\dist\cloudflared.exe",
    [string]$LogDir = "$PSScriptRoot\..\.logs"
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $LogDir "tunnel-keepalive-$stamp.log"

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

# 当前已发布的域名（进程内记忆）：只有变化了才重新发布，
# 避免每次循环都往 Gitee 推一次空 commit。
$script:lastUrl = ''

function Get-CurrentPublishedUrl {
    # 从 bot.config.json 读 api.publicUrl——那是 bridge 启动时认的地址
    try {
        $cfg = Get-Content "$PSScriptRoot\..\bot.config.json" -Raw -Encoding utf8 | ConvertFrom-Json
        return $cfg.api.publicUrl
    } catch { return '' }
}

function Update-ConfigPublicUrl([string]$newUrl) {
    # 就地替换 bot.config.json 里的 publicUrl（保持 UTF-8 无 BOM）。
    # bridge 重启时会读新值；不重启也不影响 App 自愈——App 走的是发现通道。
    $cfgPath = "$PSScriptRoot\..\bot.config.json"
    try {
        $raw = [System.IO.File]::ReadAllText($cfgPath)
        $updated = $raw -replace '"publicUrl":\s*"[^"]*"', ('"publicUrl": "' + $newUrl + '"')
        if ($updated -ne $raw) {
            [System.IO.File]::WriteAllText($cfgPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
            Write-Log "bot.config.json publicUrl → $newUrl"
        }
    } catch {
        Write-Log "改 bot.config.json 失败：$_"
    }
}

function Publish-NewUrl([string]$newUrl) {
    if ($script:lastUrl -eq $newUrl) { return }
    $script:lastUrl = $newUrl
    Update-ConfigPublicUrl $newUrl
    # 发布交给 scripts/publish-endpoint.js：读 bot.config.json 的
    # discovery.rawUrl 和 .state/instance-id，不在这边重复实现 git 流程
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) { Write-Log 'node 不在 PATH，无法发布发现文件'; return }
    $repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
    Push-Location $repoRoot
    try {
        & $node.Source (Join-Path $repoRoot 'scripts\publish-endpoint.js') $newUrl 2>&1 |
            ForEach-Object { Write-Log "node: $_" }
    } finally {
        Pop-Location
    }
}

Write-Log "隧道守护启动（target=http://127.0.0.1:$TargetPort）"

while ($true) {
    # 前一次留下的 cloudflared 进程（如有）先收尸
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    $logPath = Join-Path $LogDir "cloudflared-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
    Write-Log "启动 cloudflared，日志 $logPath"

    # stdout 里抓 https://xxx.trycloudflare.com：quick tunnel 的域名只打在 stdout
    $proc = Start-Process -FilePath $Cloudflared `
        -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$TargetPort", '--no-autoupdate', '--protocol', 'http2') `
        -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" `
        -PassThru -WindowStyle Hidden

    # 域名打在 stderr（cloudflared 的日志走 err 通道），stdout 几乎是空的；
    # 两个文件都读，哪个先出现用哪个
    $foundUrl = ''
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline -and $foundUrl -eq '') {
        Start-Sleep -Seconds 2
        if ($proc.HasExited) { break }
        foreach ($f in @("$logPath", "$logPath.err")) {
            try {
                $txt = Get-Content $f -Raw -ErrorAction SilentlyContinue
                # 注意用双引号包正则：单引号里的 \. 在 PS 解析器看来是字符串
                # 终止符问题（\. 后跟 ' 会把引号吃掉）
                if ($txt -match "https://[a-z0-9-]+\.trycloudflare\.com") { $foundUrl = $Matches[0]; break }
            } catch {}
        }
    }

    if ($foundUrl -ne '') {
        Write-Log "新隧道地址：$foundUrl"
        Publish-NewUrl $foundUrl
        # 盯住进程：只要活着就睡，掉了走外圈重启
        while (-not $proc.HasExited) { Start-Sleep -Seconds 10 }
        Write-Log 'cloudflared 进程退出了'
    } else {
        Write-Log '60 秒内没抓到隧道域名，重试'
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    }

    Start-Sleep -Seconds 5
}
