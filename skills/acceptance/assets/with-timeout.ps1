<#
  给验收 agent 用的「命令自带超时」包装（测试阶段有一份同款）。

  为什么需要它：runner 的总超时是 60 分钟，一条挂住的 adb 命令就能把整轮预算烧光。
  验收阶段实测 35 条命令带固定 `Start-Sleep -Seconds 40` 累计白等 528s，其中就有几条直接挂住，
  最后还得靠总超时收尸。这里把「等多久」交给命令自己：到点返回失败 + 现场状态，
  agent 拿着结论继续走，而不是让整个回合卡在一个永远不会返回的子进程上。

  用法（先 dot-source 一次，后面反复调用）：

    . "<skillAssets>/with-timeout.ps1"

    $r = Invoke-WithTimeout -Seconds 20 -What "点开始使用并等弹窗关闭" -Vars @{ dev = $dev } -Script {
      adb -s $dev shell input tap 540 1200
      adb -s $dev shell dumpsys window | Select-String mCurrentFocus
    }
    $r.ok        # 成功 true / 超时或报错 false
    $r.timedOut  # 是不是超时（超时时 $r.state 有现场）
    $r.output    # 命令的输出（成功时就是你要的文本）

  注意 -Script 里要用的外部变量必须经 -Vars 显式传进来（job 里是另一套作用域，
  拿不到调用方的变量），键名就是脚本里用的变量名。
#>

function Get-SceneState {
    # 超时后的现场取证：只剩「设备当前在前台干什么」这一条信息还值得留。
    # 这条取证自己也必须有界，否则取证就能再挂一次。
    param([string]$Device = '', [int]$Seconds = 3)

    $adbCmd = Get-Command adb.exe -ErrorAction SilentlyContinue
    if (-not $adbCmd) { return '（找不到 adb，跳过现场取证）' }

    $adbArgs = @()
    if ($Device) { $adbArgs += @('-s', $Device) }
    $adbArgs += @('shell', 'dumpsys window')

    $tmp = [IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $adbCmd.Source -ArgumentList $adbArgs -NoNewWindow -PassThru `
            -RedirectStandardOutput $tmp -ErrorAction Stop
        if (-not $proc.WaitForExit($Seconds * 1000)) {
            try { $proc.Kill() } catch { }
            return "（连现场取证都超时：adb $($adbArgs -join ' ') 在 ${Seconds}s 内没返回，设备可能已卡死或连接断开）"
        }
        $lines = @(Select-String -Path $tmp -Pattern 'mCurrentFocus|mFocusedApp' -ErrorAction SilentlyContinue |
            Select-Object -First 2 | ForEach-Object { $_.Line.Trim() })
        if (-not $lines.Count) { return '（取证成功，但没有读到 mCurrentFocus，可能不在图形界面栈上）' }
        return ($lines -join ' | ')
    } catch {
        return "（现场取证失败：$($_.Exception.Message)）"
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-WithTimeout {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)][scriptblock]$Script,
        [int]$Seconds = 20,
        [string]$What = '',
        [hashtable]$Vars = @{},
        [string]$Device = ''
    )

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $code = $Script.ToString()

    $job = Start-Job -ArgumentList $code, $Vars -ScriptBlock {
        param($code, $vars)
        foreach ($k in @($vars.Keys)) {
            Set-Variable -Name $k -Value $vars[$k] -Scope Global
        }
        try {
            $out = & ([scriptblock]::Create($code)) 2>&1
            [pscustomobject]@{ failed = $false; out = ($out | Out-String) }
        } catch {
            [pscustomobject]@{ failed = $true; out = ($_ | Out-String) }
        }
    }

    $finished = $job | Wait-Job -Timeout $Seconds
    $elapsed = [int]$sw.Elapsed.TotalMilliseconds

    if (-not $finished) {
        $partial = (Receive-Job $job -Keep -ErrorAction SilentlyContinue | Out-String).Trim()
        Stop-Job $job -ErrorAction SilentlyContinue
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{
            ok       = $false
            timedOut = $true
            elapsedMs = $elapsed
            what     = $What
            output   = $partial
            error    = "超时（${Seconds}s）：这条命令没在预算内返回，按失败处理，不要原地重试"
            state    = Get-SceneState -Device $Device
        }
    }

    $result = Receive-Job $job -ErrorAction SilentlyContinue | Select-Object -Last 1
    Remove-Job $job -Force -ErrorAction SilentlyContinue

    $failed = $true
    $outText = ''
    if ($result -is [pscustomobject]) {
        $failed = [bool]$result.failed
        $outText = [string]$result.out
    } else {
        # job 没按约定返回对象（被 kill、脚本里退出），当成报错而不是成功
        $outText = if ($result) { [string]$result } else { '' }
    }

    [pscustomobject]@{
        ok       = -not $failed
        timedOut = $false
        elapsedMs = $elapsed
        what     = $What
        output   = $outText.Trim()
        error    = if ($failed) { '命令报错（看 output）' } else { '' }
        state    = $null
    }
}
