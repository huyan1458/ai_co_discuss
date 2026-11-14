# AI CoDiscuss 托管机引导脚本（Windows 10/11，Windows PowerShell 5.1）
#
# 在要托管客户的那台电脑上，用你自己的 Windows 账号（不要「以管理员身份运行」）执行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File hosting-setup.ps1
#   可选参数：-PublicHost ai.example.com -TunnelName codiscuss -EntryPort 8780
#
# 本脚本只做共议装好之前必须由 PowerShell 完成的事：装 Node.js / Python（缺什么装什么）→ 装最新的共议，
# 然后把参数交给 codiscuss setup --hosting。托管机的其余配置（登录入口、外网地址的 Cloudflare 隧道、登录自启、
# 入口检查）都由 codiscuss setup --hosting 完成，之后也可以单独重新运行它。
#
# -PublicHost 可选：域名须已托管在 Cloudflare；不填则登录入口只在本机可用，之后可加 --public-host 重新运行 setup。
# 中途失败可以直接重新运行。全程输出另存一份到 %USERPROFILE%\codiscuss-hosting-setup.log。

param(
  [Alias('Hostname')][string]$PublicHost = '',
  [string]$TunnelName = '',
  [int]$EntryPort = 0
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

try {
  Write-Host 'AI CoDiscuss 托管机准备' -ForegroundColor Green
  Note "外网地址：$(if ($PublicHost) { "https://$PublicHost（Cloudflare 隧道）" } else { '不设，仅本机可用' })"
  Note "Node.js：$(if (Has node) { node --version } else { '未安装' })    Python 3.10+：$(if (Python-Ok) { '有' } else { '未安装' })    winget：$(if (Has winget) { '有' } else { '没有' })"
  $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if ($identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Warn '这个窗口是以管理员身份运行的。建议关掉，用普通窗口重新运行（自启和隧道会登记在当前账号下）。'
  }
  if ($PublicHost) { Warn '托管机的网络要由 Clash 的 TUN 模式接管（系统代理模式对多账号不可靠）。如果用了 Clash，请确认 TUN 已开启，并让 *.cloudflare.com、*.argotunnel.com 直连。' }
  Write-Host ''
  Read-Host '确认无误按回车开始（Ctrl+C 退出）' | Out-Null

  Step '1/3 Node.js（需要 24 或更新）和 Python（需要 3.10 或更新）'
  if ((Node-Major) -lt 24) { Note '安装 Node.js'; Winget-Install 'OpenJS.NodeJS' }
  if ((Node-Major) -lt 24) { throw 'Node.js 还不是 24 或更新：请关闭这个窗口，重新打开后再运行本脚本' }
  Note "Node.js $(node --version)"
  if (-not (Python-Ok)) { Note '安装 Python 3.12'; Winget-Install 'Python.Python.3.12' }
  if (-not (Python-Ok)) { throw '还没找到 Python 3.10+：请关闭这个窗口，重新打开后再运行本脚本' }
  Note 'Python 已就绪'

  Step '2/3 安装最新的共议'
  npm install --global --prefer-online ai_co_discuss@latest
  if ($LASTEXITCODE -ne 0) { throw 'npm 安装共议失败（网络问题时可以重新运行本脚本）' }
  Refresh-Path
  if (-not (Has codiscuss)) { throw '装好了但找不到 codiscuss 命令：请关闭这个窗口，重新打开后再运行本脚本' }

  Step '3/3 codiscuss setup --hosting（会问你接入哪些 AI 软件；请勾选创建桌面快捷方式，登录自启要用到它）'
  $arguments = @('setup', '--hosting')
  if ($PublicHost) { $arguments += @('--public-host', $PublicHost) }
  if ($TunnelName) { $arguments += @('--tunnel-name', $TunnelName) }
  if ($EntryPort -gt 0) { $arguments += @('--entry-port', "$EntryPort") }
  & codiscuss @arguments
  $setup_code = $LASTEXITCODE
  if ($setup_code -eq 1) { throw 'codiscuss setup 失败，看上面的报错' }

  codiscuss panel open | Out-Null
  Write-Host ''
  if ($setup_code -eq 2) { Write-Host '安装完成，但还有待处理项（见上面的黄色提示）；处理后可单独重新运行 codiscuss setup --hosting。' -ForegroundColor Yellow }
  else { Write-Host '全部完成。' -ForegroundColor Green }
  Write-Host '接下来在管理面板里：'
  Write-Host '  1. 「账号」页左侧点「新建账号」：勾「隔离」，向导会自动开启入口保护；电脑弹出管理员确认时点「是」'
  Write-Host '  2. 在「账号」页选中这个账号，给它登录 AI 软件（Claude Code / Codex / Antigravity）'
  Write-Host "  3. 用手机打开登录入口（概览页「托管」下可看到地址），用那个账号登录试试"
  Write-Host "完整记录在 $log 。"
  $failed = $false
} catch {
  $failed = $true
  Write-Host "`n出错了：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "完整记录在 $log 。修好后直接重新运行本脚本。" -ForegroundColor Red
} finally {
  Stop-Transcript | Out-Null
}
# 右键「使用 PowerShell 运行」时，窗口会在脚本结束后立刻关闭；停一下，让你看完结果。
Read-Host "`n按回车关闭这个窗口" | Out-Null
if ($failed) { exit 1 }
