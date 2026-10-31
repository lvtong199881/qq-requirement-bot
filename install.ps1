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

.PARAMETER DshPath
  dsh 可执行文件的完整路径。不填则自动从 PATH 和 DeepSeek Harness 安装目录里找。

.PARAMETER Provider
  模型供应商，如 opencode-go。留空则沿用 dsh profile 的默认行为（deepseek）。

.PARAMETER Model
  模型名，如 deepseek-v4.1-flash。

.PARAMETER ApiKeyEnv
  供应商读 API key 的环境变量名，如 OPENCODE_GO_API_KEY。

.PARAMETER ApiKey
  API key 值。填了会写进当前用户环境变量（ApiKeyEnv）。

.PARAMETER SkipDshInstall
  找不到 dsh 时不要自动下载安装。

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
  [string]$DshPath = '',
  [string]$Provider = '',
  [string]$Model = '',
  [string]$ApiKeyEnv = '',
  [string]$ApiKey = '',
  [int]$PanelPort = 7878,
  [switch]$SkipDoctor,
  [switch]$SkipDshInstall,
  [switch]$Yes,
  [switch]$DryRun
)

# DeepSeek Harness Windows 安装包（官方 latest 链接）
$DshInstallerUrl = 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe'

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

# dsh 是 DeepSeek Harness 桌面应用自带的 CLI，不是 npm 包。
# 找不到时可以自动下载官方安装包静默安装（-SkipDshInstall 可跳过）。
function Find-Dsh {
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.exe'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.exe')
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  return ''
}

if (-not $DshPath) { $DshPath = Find-Dsh }

if (-not $DshPath -and -not $SkipDshInstall) {
  $doInstall = $false
  if ($Yes) {
    $doInstall = $true
  } else {
    $ans = Read-Host '  没找到 dsh。现在下载并安装 DeepSeek Harness？（约 200MB，装到当前用户目录）[y/N]'
    if ($ans -match '^[yY]') { $doInstall = $true }
  }

  if ($doInstall) {
    $tmp = Join-Path $env:TEMP 'dsh-setup.exe'
    Step "下载 DeepSeek Harness → $tmp"
    try {
      # PS 5.1 默认可能还是 TLS 1.0，download.deepseek.com 要 1.2
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $wc = New-Object System.Net.WebClient
      $wc.DownloadFile($DshInstallerUrl, $tmp)
      $wc.Dispose()
      Ok '下载完成'

      Step '静默安装（/S）…'
      Start-Process -FilePath $tmp -ArgumentList '/S' -Wait | Out-Null
      # 安装器可能先返回、后台才落盘，轮询几次再判定
      for ($i = 0; $i -lt 6 -and -not $DshPath; $i++) {
        Start-Sleep -Seconds 5
        $DshPath = Find-Dsh
      }
    } catch {
      Warn "自动安装失败：$($_.Exception.Message)"
      Warn "可以手动下载安装：$DshInstallerUrl"
    }
  }
}

if ($DshPath) {
  $dshBin = $DshPath
  Ok "dsh：$DshPath"
} else {
  $dshBin = 'dsh'
  Warn '找不到 dsh。装 DeepSeek Harness 后重跑本脚本会自动识别；'
  Warn "也可以手动指定：.\install.ps1 -DshPath `"C:\...\dsh.cmd`""
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

# 模型供应商由用户自己填：不替用户选，也不硬编码某一家。
if (-not $Provider -and -not $Yes) {
  $Provider = Ask '模型供应商 provider（如 opencode-go；直接回车 = 用 dsh 默认 deepseek）' ''
}
if ($Provider) {
  if (-not $Model) { $Model = Ask '模型名（如 deepseek-v4.1-flash）' '' }
  if (-not $ApiKeyEnv) { $ApiKeyEnv = Ask 'API key 环境变量名（如 OPENCODE_GO_API_KEY）' '' }
  if (-not $ApiKey -and -not $Yes) { $ApiKey = Ask 'API key 值（可留空，稍后自己设）' '' }
}

# 把选择写进 dsh profile 的 patch 层，dsh 启动时按它选 provider。
if ($Provider -and $Model) {
  $patchPath = Join-Path $profileDst 'cordis.patch.yml'
  $patch = @"
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: $Provider
    model: $Model
"@
  if ($DryRun) {
    Ok "[dry-run] 会写入模型配置 $Provider/$Model"
  } else {
    [System.IO.File]::WriteAllText($patchPath, $patch, (New-Object System.Text.UTF8Encoding($false)))
    Ok "模型已指向 $Provider/$Model"
  }
}

if ($ApiKey -and $ApiKeyEnv) {
  if ($DryRun) {
    Ok "[dry-run] 会设置用户环境变量 $ApiKeyEnv"
  } else {
    [Environment]::SetEnvironmentVariable($ApiKeyEnv, $ApiKey, 'User')
    Ok "已写入用户环境变量 $ApiKeyEnv（重开窗口生效）"
  }
}

$cfgPath = Join-Path $Root 'bot.config.json'
if (Test-Path $cfgPath) {
  Ok 'bot.config.json 已存在，跳过'
  # 之前生成时 dshBin 可能还是占位的 dsh；这次探测到真实路径就补上，
  # 省得用户为了一个字段删配置重来。
  if ($dshBin -ne 'dsh' -and -not $DryRun) {
    try {
      $existing = Get-Content $cfgPath -Raw | ConvertFrom-Json
      if (-not $existing.dshBin -or $existing.dshBin -eq 'dsh') {
        $existing.dshBin = $dshBin
        $json = $existing | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Ok "已更新 bot.config.json 的 dshBin → $dshBin"
      }
    } catch {
      Warn "更新 dshBin 失败：$($_.Exception.Message)"
    }
  }

  # 模型配置同理：已有配置也要能通过重跑补上/改掉
  if ($Provider -and -not $DryRun) {
    try {
      $existing = Get-Content $cfgPath -Raw | ConvertFrom-Json
      $existing.model = [ordered]@{ provider = $Provider; model = $Model; apiKeyEnv = $ApiKeyEnv }
      $json = $existing | ConvertTo-Json -Depth 10
      [System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
      Ok "已更新 bot.config.json 的 model → $Provider/$Model"
    } catch {
      Warn "更新 model 失败：$($_.Exception.Message)"
    }
  }
} else {
  if (-not $Qq) {
    $Qq = Ask '你的 QQ 号（写进 superAdmin，可留空）' ''
  }

  $repoName = Split-Path $Repo -Leaf
  $admins = @()
  if ($Qq) { $admins = @($Qq) }

  $cfg = [ordered]@{
    repos        = @([ordered]@{ id = 'app'; name = $repoName; path = $Repo })
    dshBin       = $dshBin
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

  if ($Provider) {
    $cfg.model = [ordered]@{ provider = $Provider; model = $Model; apiKeyEnv = $ApiKeyEnv }
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
    Warn '常见一项：DEEPSEEK_API_KEY 没设（见 docs/INSTALL.md）'
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
