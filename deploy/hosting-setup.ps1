# AI CoDiscuss 托管机一键准备脚本（Windows 10/11，Windows PowerShell 5.1）
#
# 在要托管客户的那台电脑上，用你自己的 Windows 账号（不要「以管理员身份运行」）执行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File hosting-setup.ps1
#   可选参数：-Hostname ai.vibedrafting.ai -TunnelName codiscuss -EntryPort 8780
#
# 它会：安装 Node.js / Python（缺什么装什么）→ 安装共议并打开「托管管理」→ 安装 cloudflared →
# 建一条 Cloudflare 固定隧道，把 https://<Hostname> 转到本机入口 → 设好「客户入口」、登录自启 →
# 最后从本机和公网各检查一次入口能不能打开。
#
# 需要你在场的只有：开始前的确认、setup 里选择要接入的 AI 软件、Cloudflare 浏览器授权、可能出现的安装确认框。
# 中途失败可以直接重新运行：做过的步骤会跳过。全程输出另存一份到 %USERPROFILE%\codiscuss-hosting-setup.log。

param(
  [string]$Hostname = 'ai.vibedrafting.ai',
  [string]$TunnelName = 'codiscuss',
  [int]$EntryPort = 8780
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$log = Join-Path $env:USERPROFILE 'codiscuss-hosting-setup.log'
Start-Transcript -Path $log -Append | Out-Null

function Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Note([string]$Text) { Write-Host "   $Text" -ForegroundColor DarkGray }
function Warn([string]$Text) { Write-Host "   注意：$Text" -ForegroundColor Yellow }
function Has([string]$Command) { [bool](Get-Command $Command -ErrorAction SilentlyContinue) }
# 新装的程序要重新读 PATH 才找得到。
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Winget-Install([string]$Id) {
  if (-not (Has winget)) { throw '没有 winget：请先从 Microsoft Store 安装「应用安装程序」，再重新运行本脚本' }
  winget install --id $Id -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
}
function Node-Major { if (Has node) { [int]((node --version).TrimStart('v').Split('.')[0]) } else { 0 } }
function Python-Ok {
  foreach ($candidate in @(@('py', '-3'), @('python'))) {
    if (-not (Has $candidate[0])) { continue }
    $arguments = @($candidate | Select-Object -Skip 1) + @('-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)')
    try { & $candidate[0] @arguments 2>$null; if ($LASTEXITCODE -eq 0) { return $true } } catch { }
  }
  return $false
}
# 等到地址返回 200，最多 $Seconds 秒。
function Wait-Ok([string]$Url, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try { if ((Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200) { return $true } } catch { }
    Start-Sleep -Seconds 3
  }
  return $false
}
function Tunnel-Of([string]$Name) {
  $text = (cloudflared tunnel list --output json) -join "`n"
  if (-not $text.Trim()) { return $null }
  return @($text | ConvertFrom-Json) | Where-Object { $_.name -eq $Name } | Select-Object -First 1
}

try {
  # ---- 开始前确认 ----
  Write-Host 'AI CoDiscuss 托管机准备' -ForegroundColor Green
  Note "公网地址：https://$Hostname    隧道名：$TunnelName    入口端口：$EntryPort"
  Note "Windows：$([Environment]::OSVersion.Version)    账号：$env:USERNAME"
  Note "Node.js：$(if (Has node) { node --version } else { '未安装' })    Python 3.10+：$(if (Python-Ok) { '有' } else { '未安装' })    cloudflared：$(if (Has cloudflared) { '有' } else { '未安装' })    winget：$(if (Has winget) { '有' } else { '没有' })"
  $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if ($identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Warn '这个窗口是以管理员身份运行的。建议关掉，用普通窗口重新运行（隧道和自启会登记在当前账号下）。'
  }
  Warn '托管机的网络要由 Clash 的 TUN 模式接管（系统代理模式对多账号不可靠）。如果用了 Clash，请确认 TUN 已开启，并让 *.cloudflare.com、*.argotunnel.com 直连。'
  Write-Host ''
  Read-Host '确认无误按回车开始（Ctrl+C 退出）' | Out-Null

  Step '1/7 Node.js（需要 24 或更新）和 Python（需要 3.10 或更新）'
  if ((Node-Major) -lt 24) { Note '安装 Node.js'; Winget-Install 'OpenJS.NodeJS' }
  if ((Node-Major) -lt 24) { throw 'Node.js 还不是 24 或更新：请关闭这个窗口，重新打开后再运行本脚本' }
  Note "Node.js $(node --version)"
  if (-not (Python-Ok)) { Note '安装 Python 3.12'; Winget-Install 'Python.Python.3.12' }
  if (-not (Python-Ok)) { throw '还没找到 Python 3.10+：请关闭这个窗口，重新打开后再运行本脚本' }
  Note 'Python 已就绪'

  Step '2/7 安装最新的共议'
  npm install --global ai_co_discuss@latest
  if ($LASTEXITCODE -ne 0) { throw 'npm 安装共议失败（网络问题时可以重新运行本脚本）' }
  Refresh-Path
  if (-not (Has codiscuss)) { throw '装好了但找不到 codiscuss 命令：请关闭这个窗口，重新打开后再运行本脚本' }

  Step '3/7 配置共议并打开「托管管理」（会问你接入哪些 AI 软件；建议勾选创建桌面快捷方式）'
  codiscuss setup --hosting
  if ($LASTEXITCODE -eq 1) { throw 'codiscuss setup 失败，看上面的报错' }
  if ($LASTEXITCODE -eq 2) { Warn 'setup 完成了，但有待处理的项目（见上面），之后再看即可' }

  Step '4/7 安装 cloudflared'
  if (-not (Has cloudflared)) { Winget-Install 'Cloudflare.cloudflared' }
  if (-not (Has cloudflared)) { throw '没有找到 cloudflared：请关闭这个窗口，重新打开后再运行本脚本' }
  Note "$(cloudflared --version)"

  Step "5/7 Cloudflare 固定隧道：https://$Hostname → 本机 $EntryPort 端口"
  $tunnel_home = Join-Path $env:USERPROFILE '.cloudflared'
  if (-not (Test-Path (Join-Path $tunnel_home 'cert.pem'))) {
    Note '马上会打开浏览器：登录 Cloudflare，在列表里点 vibedrafting.ai，再点 Authorize；页面提示成功后回到这里'
    cloudflared tunnel login
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $tunnel_home 'cert.pem'))) { throw 'Cloudflare 授权没有完成，重新运行本脚本即可再试' }
  } else { Note '已授权过 Cloudflare' }
  $tunnel = Tunnel-Of $TunnelName
  if (-not $tunnel) {
    cloudflared tunnel create $TunnelName
    if ($LASTEXITCODE -ne 0) { throw '隧道没有建成，看上面的报错' }
    $tunnel = Tunnel-Of $TunnelName
  } else { Note "隧道 $TunnelName 已存在：$($tunnel.id)" }
  if (-not $tunnel) { throw '隧道建了却读不到，请重新运行本脚本' }
  $credentials = Join-Path $tunnel_home "$($tunnel.id).json"
  if (-not (Test-Path $credentials)) { throw "找不到隧道凭据 $credentials：这条隧道可能是在别的电脑上建的，请加参数 -TunnelName codiscuss2 重新运行" }
  $config = Join-Path $tunnel_home 'config.yml'
  # http2：走 TCP 443，比默认的 QUIC（UDP）更不容易被代理软件挡住。
  $yaml = @"
tunnel: $($tunnel.id)
credentials-file: $credentials
protocol: http2
ingress:
  - hostname: $Hostname
    service: http://127.0.0.1:$EntryPort
  - service: http_status:404
"@
  [IO.File]::WriteAllText($config, $yaml, (New-Object Text.UTF8Encoding($false)))
  Note "隧道配置写在 $config"
  cloudflared tunnel route dns $TunnelName $Hostname
  if ($LASTEXITCODE -ne 0) { Warn "没有新建 $Hostname 的域名记录。若它已经指向这条隧道可以忽略；最后一步的公网检查会告诉你是否通了" }

  # 登录这台电脑后自动在后台运行隧道（隐藏窗口，用你自己的账号），现在也先启动一次。
  $cloudflared = (Get-Command cloudflared).Source
  $run = "-NoProfile -WindowStyle Hidden -Command `"& '$cloudflared' tunnel --config '$config' run $TunnelName`""
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  $registered = $false
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $run
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName 'CoDiscuss Tunnel' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName 'CoDiscuss Tunnel'
    $registered = $true
    Note '隧道已登记为登录后自动运行（任务计划程序里的「CoDiscuss Tunnel」，断开后每分钟自动重试）'
  } catch {
    Warn "任务计划登记失败（$($_.Exception.Message)），改用「登录时启动」项"
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'CoDiscussTunnel' -Value "powershell.exe $run"
    Start-Process powershell.exe -ArgumentList $run -WindowStyle Hidden
    Note '隧道已登记为登录时启动，并已在后台运行'
  }

  Step '6/7 客户入口、管理面板与登录自启'
  $data = Join-Path $env:USERPROFILE '.codiscuss'
  $settings_file = Join-Path $data 'gateway-settings.json'
  $entry = @{}
  if (Test-Path $settings_file) { try { (Get-Content $settings_file -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $entry[$_.Name] = $_.Value } } catch { } }
  $entry['port'] = $EntryPort; $entry['public_url'] = "https://$Hostname"; $entry['running'] = $true
  [IO.File]::WriteAllText($settings_file, ($entry | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  Note "客户入口：本机 $EntryPort 端口，公网地址 https://$Hostname，随面板自动启动"
  # 面板启动时才读入口设置，所以重启一次面板（任务栏图标会消失再出现）。
  codiscuss panel stop | Out-Null
  codiscuss panel start
  if ($LASTEXITCODE -ne 0) { throw '管理面板没有启动，看上面的报错' }
  codiscuss service autostart on
  if ($LASTEXITCODE -ne 0) { Warn '没有开成登录自启（可能 setup 时没有创建桌面快捷方式）。之后在面板「概览」页打开「随 Windows 启动」' }

  Step '7/7 检查入口能不能打开'
  $local_ok = Wait-Ok "http://127.0.0.1:$EntryPort/_entry/login" 60
  if ($local_ok) { Note "本机入口 http://127.0.0.1:$EntryPort 正常" } else { Warn "本机入口 60 秒内没有打开：在管理面板「托管账号」页的「客户入口」点「启动」，看提示的原因" }
  $public_ok = $local_ok -and (Wait-Ok "https://$Hostname/_entry/login" 120)
  if ($public_ok) { Note "公网入口 https://$Hostname 正常" }
  elseif ($local_ok) { Warn "公网地址 2 分钟内没有打开。依次检查：Cloudflare DNS 页面里 $Hostname 是否是一条指向隧道的 CNAME（被别的记录占用要先删掉）；Clash 是否放行了 Cloudflare；任务计划里「CoDiscuss Tunnel」是否在运行。改好后重新运行本脚本" }

  codiscuss panel open | Out-Null
  Write-Host ''
  if ($public_ok) { Write-Host '全部完成。' -ForegroundColor Green } else { Write-Host '安装完成，但入口检查没有全部通过（见上面的黄色提示）。' -ForegroundColor Yellow }
  Write-Host '接下来在管理面板里：'
  Write-Host '  1. 「托管账号」页新建账号：勾「隔离」，向导会自动开启入口保护；电脑弹出管理员确认时点「是」'
  Write-Host '  2. 在账号页给它登录 AI 软件（Claude / Codex / Antigravity）'
  Write-Host "  3. 用手机打开 https://$Hostname ，用那个账号登录试试，然后按房间里的验收清单逐项检查"
  Write-Host "完整记录在 $log ，有问题把它发到房间里。"
  $failed = $false
} catch {
  $failed = $true
  Write-Host "`n出错了：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "完整记录在 $log 。修好后直接重新运行本脚本，做过的步骤会跳过。" -ForegroundColor Red
} finally {
  Stop-Transcript | Out-Null
}
# 右键「使用 PowerShell 运行」时，窗口会在脚本结束后立刻关闭；停一下，让你看完结果。
Read-Host "`n按回车关闭这个窗口" | Out-Null
if ($failed) { exit 1 }
