/**
 * Windows taskbar icon for the computer owner's management panel.
 *
 * Node has no tray API, so a hidden PowerShell child owns a Windows Forms NotifyIcon and reports each menu choice as one
 * word on its standard output. The icon lives exactly as long as that child.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

// Menu entries the icon offers: [label, action reported on standard output].
const MENU = [['打开管理面板', 'open'], ['打开共议', 'site'], ['-', ''], ['重启服务', 'restart'], ['关闭服务', 'stop']];
const ACTIONS = new Set(MENU.map(([, action]) => action).filter(Boolean));
const ICON_SIZE = 32;

/**
 * The PowerShell program behind the icon.
 *
 * Args:
 *   title: The tooltip shown when hovering the icon.
 *   icon_path: An optional .ico of the mark (the launcher renders one); without it a plain version is drawn.
 */
export function tray_script(title, icon_path = '', owner_pid = 0, window_title = '') {
  const quote = text => `'${String(text).replaceAll("'", "''")}'`;
  // Each entry carries its action in Tag, so one plain handler serves them all (no closures over script functions).
  // Without a panel (no window title) there is no entry to open it, and a left click opens the site instead.
  const items = MENU.filter(([, action]) => window_title || action !== 'open').map(([label, action]) => label === '-' ? '$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null'
    : `$item = $menu.Items.Add(${quote(label)}); $item.Tag = ${quote(action)}; $item.add_Click({ param($source) if ($source.Tag -eq 'open') { Open-Panel } elseif ($source.Tag -ne 'stop' -or [System.Windows.Forms.MessageBox]::Show('关闭共议服务？本机网站、讨论服务与管理面板都会停止，托管用户的实例不受影响。', '共议', 'YesNo', 'Question') -eq 'Yes') { Say $source.Tag } })`).join('\n');
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Say($word) { [Console]::Out.WriteLine($word); [Console]::Out.Flush() }
# Show the panel: bring its window forward when open, otherwise ask the owner to open one. A window takes a few seconds
# to appear, so a second click meanwhile does not ask again.
$script:asked = [DateTime]::MinValue
function Open-Panel {
  if ($panel -and [PanelWindow]::Focus($panel)) { return }
  if (([DateTime]::Now - $script:asked).TotalSeconds -lt 10) { return }
  $script:asked = [DateTime]::Now
  Say 'open'
}
$icon = New-Object System.Windows.Forms.NotifyIcon
# Fallback when no rendered image is given: the four strokes of the mark in its light-theme colours on a white rounded tile.
function Draw-Mark {
  $size = ${ICON_SIZE}
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
  $radius = 5; $edge = $size
  $tile.AddArc(0, 0, $radius * 2, $radius * 2, 180, 90); $tile.AddArc($edge - $radius * 2, 0, $radius * 2, $radius * 2, 270, 90)
  $tile.AddArc($edge - $radius * 2, $edge - $radius * 2, $radius * 2, $radius * 2, 0, 90); $tile.AddArc(0, $edge - $radius * 2, $radius * 2, $radius * 2, 90, 90)
  $graphics.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)), $tile)
  $scale = $size / 100.0
  foreach ($stroke in @(@(12, 64, 88, 64, 59, 64, 69), @(16, 36, 84, 36, 193, 116, 184), @(29, 88, 39, 12, 217, 119, 87), @(71, 88, 61, 12, 90, 92, 255))) {
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($stroke[4], $stroke[5], $stroke[6]), (11 * $scale))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $map = { param($value) 9 * $scale + $value * 0.82 * $scale }
    $graphics.DrawLine($pen, (& $map $stroke[0]), (& $map $stroke[1]), (& $map $stroke[2]), (& $map $stroke[3]))
  }
  $graphics.Dispose()
  return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
}
$picture = ${quote(icon_path)}
try {
  # An .ico is read by Windows itself, which keeps the soft edges; turning a bitmap into an icon here would darken them.
  if ($picture -like '*.ico') { $icon.Icon = New-Object System.Drawing.Icon($picture, [System.Windows.Forms.SystemInformation]::SmallIconSize) }
  else { $icon.Icon = Draw-Mark }
} catch { $icon.Icon = [System.Drawing.SystemIcons]::Application }
$icon.Text = ${quote(String(title).slice(0, 63))}
$menu = New-Object System.Windows.Forms.ContextMenuStrip
${items}
$icon.ContextMenuStrip = $menu
$icon.add_MouseClick({ param($source, $click) if ($click.Button -eq [System.Windows.Forms.MouseButtons]::Left) { if ($panel) { Open-Panel } else { Say 'site' } } })
$icon.Visible = $true
# The icon goes away with its owner. Reading standard input would block the message loop (Console.In is synchronous in
# Windows PowerShell), so a timer checks that the owner process is still there instead.
$owner = ${Number(owner_pid) || 0}
# The panel's own window (Edge in app mode) gets its taskbar icon from the page, and Edge lays a dark backing under the
# rounded corners; the same tick gives that window this icon file instead, again whenever Edge puts its own back.
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class PanelWindow {
  public delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, int message, IntPtr kind, IntPtr icon);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  // Windows with exactly this title, oldest first in z-order terms is not guaranteed; the first found is kept.
  public static List<IntPtr> Find(string title) {
    var found = new List<IntPtr>();
    EnumWindows((window, data) => { var text = new StringBuilder(256); GetWindowText(window, text, 256); if (text.ToString() == title) found.Add(window); return true; }, IntPtr.Zero);
    return found;
  }
  // Bring the window forward; this process has just been clicked, so Windows lets it take the foreground.
  public static bool Focus(string title) {
    var windows = Find(title);
    if (windows.Count == 0) return false;
    if (IsIconic(windows[0])) ShowWindow(windows[0], 9);
    SetForegroundWindow(windows[0]);
    return true;
  }
  // Keep one panel window: close any extra, and give the one left this icon if Edge has put its own back.
  public static void Tend(string title, IntPtr small, IntPtr big) {
    var windows = Find(title);
    for (int index = 1; index < windows.Count; index++) PostMessage(windows[index], 0x10, IntPtr.Zero, IntPtr.Zero);
    if (windows.Count > 0 && small != IntPtr.Zero && SendMessage(windows[0], 0x7F, (IntPtr)0, IntPtr.Zero) != small) {
      SendMessage(windows[0], 0x80, (IntPtr)0, small); SendMessage(windows[0], 0x80, (IntPtr)1, big);
    }
  }
}
'@
$panel = ${quote(window_title)}
$brand = $null
if ($picture -like '*.ico') { try { $brand = @((New-Object System.Drawing.Icon($picture, 16, 16)), (New-Object System.Drawing.Icon($picture, 32, 32))) } catch { $brand = $null } }
$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 2000
$watch.add_Tick({
  if ($owner -and -not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) { [System.Windows.Forms.Application]::Exit() }
  if ($panel) { if ($brand) { [PanelWindow]::Tend($panel, $brand[0].Handle, $brand[1].Handle) } else { [PanelWindow]::Tend($panel, [IntPtr]::Zero, [IntPtr]::Zero) } }
})
$watch.Start()
Say 'ready'
[System.Windows.Forms.Application]::Run()
$icon.Visible = $false
$icon.Dispose()
`;
}

/**
 * Show the icon and report menu choices.
 *
 * Args:
 *   title: Tooltip text.
 *   on_action: Called with 'open', 'site', 'restart' or 'stop' (the last only after the owner confirmed it).
 *   icon_path: Optional icon file.
 *   window_title: The title of a window of ours that should carry the same icon (the panel window).
 *   host: The launcher exe (launcher.mjs); when it and an .ico exist, it shows the icon instead of a PowerShell child.
 *   spawn_process: Injected for tests.
 *
 * Returns:
 *   { close() } to remove the icon, or null where there is no Windows desktop.
 */
export function show_tray({ title, on_action, icon_path = '', window_title = '', host = '', spawn_process = spawn, platform = process.platform }) {
  if (platform !== 'win32') return null;
  let child;
  if (host && icon_path && existsSync(host)) {
    // The launcher exe hosts the icon, so Windows keeps the owner's "show on the taskbar" choice for it across restarts.
    child = spawn_process(host, ['--tray', String(process.pid), icon_path, title, window_title || '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    // Windows PowerShell 5.1 reads a script file without a byte-order mark in the ANSI code page, which garbles Chinese labels.
    const script = join(tmpdir(), `codiscuss-tray-${process.pid}.ps1`);
    writeFileSync(script, `﻿${tray_script(title, icon_path, process.pid, window_title)}`, 'utf8');
    child = spawn_process('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines.map(text => text.trim())) if (ACTIONS.has(line)) on_action(line);
  });
  child.on('error', () => {});
  return { child, close() { try { child.kill(); } catch {} } };
}
