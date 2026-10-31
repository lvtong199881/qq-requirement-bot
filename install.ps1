#Requires -Version 5.1
<#
.SYNOPSIS
  Windows 一键安装：环境检查、dsh profile、bot.config.json、自检。

.DESCRIPTION
  不注册 Windows 服务；跑通后手动 node src/index.js。
  能自动化的都做了，剩下的只有 QQ 扫码、拉群、填 API key、装 DevEco。

.PARAMETER Repo
  需求要落到的项目仓库路径。不存在会自动建空目录。

.PARAMETER Qq
  你的 QQ 号，写进 superAdmin。

.PARAMETER PanelPort
  面板端口，默认 7878。

.PARAMETER SkipDoctor
  跳过最后的 node src/doctor.js。

.PARAMETER Yes
  全部用默认值，不交互。

.PARAMETER DryRun
  只打印会做什么，不写盘。

.EXAMPLE
  .\install.ps1 -Repo C:\work\my-app -Qq 123456789

.EXAMPLE
  .\install.ps1 -Yes -Repo C:\work\my-app
#>
[CmdletBinding()]
param(
  [string]$Repo = '',
  [string]$Qq = '',
  [int]$PanelPort = 7878,
  [switch]$SkipDoctor,
  [switch]$Yes,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Step($m) { Write-Host "`n> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "  [XX] $m" -ForegroundColor Red }

function Ask($m, $default) {
  if ($Yes) { return $default }
  $v = Read-Host "  $m"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v.Trim()
}

Write-Host ''
Write-Host 'qq-requirement-bot · Windows 安装' -ForegroundColor White
Write-Host '─────────────────────────────────' -ForegroundColor DarkGray
if ($DryRun) { Warn 'DryRun：只打印，不写盘' }

# ── 1/5 环境 ─────────────────────────────────────────────
Step '1/5 检查环境'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Bad '找不到 node。先装：winget install OpenJS.NodeJS.LTS --source winget --architecture arm64'
  exit 1
}
$nodeVer = (& node -v).Trim()
$nodeMajor = [int](($nodeVer -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 22) {
  Bad "Node $nodeVer 太旧，需要 >= 22"
  exit 1
}
Ok "Node $nodeVer"

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
  Bad '找不到 git。先装：winget install Git.Git --source winget'
  exit 1
}
Ok ((& git --version).Trim())

$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
  $dshPath = $dshCmd.Source
  Ok "dsh：$dshPath"
} else {
  # 找不到也继续：用户可能稍后才装，或要手写完整路径
  $dshPath = 'dsh'
  Warn 'PATH 里找不到 dsh。装好后把完整路径写进 bot.config.json 的 dshBin'
}

# ── 2/5 仓库 ─────────────────────────────────────────────
Step '2/5 项目仓库'

if (-not $Repo) {
  $defaultRepo = Join-Path $env:USERPROFILE 'qq-bot-test'
  $Repo = Ask "项目仓库路径（需求要落到哪个业务代码仓库；直接回车 = 先用空目录 $defaultRepo 跑通，稍后再改）" $defaultRepo
}
if (-not $Repo) {
  Bad '没有仓库路径'
  exit 1
}

if (Test-Path $Repo) {
  Ok "仓库目录：$Repo"
} elseif ($DryRun) {
  Ok "[dry-run] 会创建目录 $Repo"
} else {
  New-Item -ItemType Directory -Path $Repo -Force | Out-Null
  Ok "已创建空目录 $Repo（把项目放进来，或在 bot.config.json 里改成 git url）"
}

# ── 3/5 dsh profile ──────────────────────────────────────
Step '3/5 dsh profile'

$profileSrc = Join-Path $Root 'profiles\qqbot'
$profileDst = Join-Path $env:USERPROFILE '.dsh\profiles\qqbot'

if (Test-Path $profileDst) {
  Ok "profile 已存在：$profileDst"
} elseif ($DryRun) {
  Ok "[dry-run] 会复制 $profileSrc → $profileDst"
} else {
  New-Item -ItemType Directory -Path (Split-Path $profileDst) -Force | Out-Null
  Copy-Item -Recurse -Path $profileSrc -Destination $profileDst
  Ok "已复制 profile → $profileDst"
}

# ── 4/5 配置 ─────────────────────────────────────────────
Step '4/5 bot.config.json'

$cfgPath = Join-Path $Root 'bot.config.json'
if (Test-Path $cfgPath) {
  Ok 'bot.config.json 已存在，跳过（想重来先备份删除）'
} else {
  if (-not $Qq) {
    $Qq = Ask '你的 QQ 号（写进 superAdmin，可留空）' ''
  }

  $repoName = Split-Path $Repo -Leaf
  $admins = @()
  if ($Qq) { $admins = @($Qq) }

  $cfg = [ordered]@{
    repos        = @([ordered]@{ id = 'app'; name = $repoName; path = $Repo })
    skillDir     = ''
    dshBin       = $dshPath
    profile      = 'qqbot'
    bot          = [ordered]@{ qq = $Qq; name = '产品同学' }
    onebot       = [ordered]@{ ws = 'ws://127.0.0.1:3001'; token = '' }
    groupPolicy  = [ordered]@{ mode = 'auto' }
    approval     = 'manual'
    limits       = [ordered]@{ maxMessagesPerMinute = 10; chunkChars = 3000; maxChunksPerTurn = 4 }
    heartbeat    = [ordered]@{ enabled = $true; idleMinutes = 5 }
    upload       = [ordered]@{
      enabled   = $true
      patterns  = @('**/*.md', '**/*.png', '**/*.jpg')
      maxFiles  = 8
      maxFileMB = 20
    }
    turnTimeoutMs = 1800000
    stageTimeouts = [ordered]@{ default = 30; dev = 60; test = 60; acceptance = 60 }
    panel        = [ordered]@{
      enabled    = $true
      port       = $PanelPort
      publicPort = ($PanelPort + 1)
      token      = ''
    }
    superAdmin   = $admins
  }

  $json = $cfg | ConvertTo-Json -Depth 10
  if ($DryRun) {
    Ok "[dry-run] 会写入 bot.config.json（repos=$Repo，panel=$PanelPort）"
  } else {
    # 必须无 BOM：Node 的 JSON.parse 不吃 BOM，PS 5.1 的 Set-Content 会加
    [System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Ok "已生成 bot.config.json（repos=$Repo，panel=$PanelPort）"
  }
}

# ── 5/5 NapCat 与自检 ────────────────────────────────────
Step '5/5 NapCat 与自检'

$wsOk = $false
try {
  $client = New-Object System.Net.Sockets.TcpClient
  $async = $client.BeginConnect('127.0.0.1', 3001, $null, $null)
  $wsOk = $async.AsyncWaitHandle.WaitOne(1500, $false) -and $client.Connected
  $client.Close()
} catch {
  $wsOk = $false
}

if ($wsOk) {
  Ok 'OneBot 端口 3001 可连通'
} else {
  Warn 'OneBot 3001 没起来——先装官方 QQ + NapCat Windows 一键包，扫码后在 WebUI 开正向 WS 3001'
}

if (-not $SkipDoctor -and -not $DryRun) {
  & node src/doctor.js
  if ($LASTEXITCODE -eq 0) {
    Ok 'doctor 通过'
  } else {
    Warn 'doctor 有未通过项，按上面的提示修'
    Warn '常见两项：DEEPSEEK_API_KEY 没设；requirement-spec skill 没放（见 docs/INSTALL.md）'
  }
}

Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  1. 装官方 QQ（im.qq.com）和 NapCat Windows 一键包'
Write-Host '  2. 打开 http://127.0.0.1:6099/webui 扫码登录小号'
Write-Host '  3. NapCat 里开启正向 WebSocket（端口 3001）'
Write-Host '  4. 把 bot 拉进群，@ 它说一句需求'
Write-Host '  5. 启动 bridge：node src/index.js'
Write-Host ''
