/**
 * A double-click launcher for Windows: 共议.exe, with shortcuts on the desktop and in the Start menu.
 *
 * The exe is compiled on this computer with the C# compiler that ships with .NET Framework 4 on every Windows 10/11, so
 * nothing is downloaded and Windows does not warn about an unsigned file from the internet. It starts the owner's local
 * service (`codiscuss local open`, which opens the site once ready) and the management panel with its taskbar icon,
 * without a console window. The paths of node and the scripts are written into the exe; run `codiscuss launcher` again
 * after moving them.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(RUNNER);
const EXE_NAME = '共议.exe';
const SHORTCUT_NAME = '共议.lnk';
const ICON_SIZES = [256, 48, 32, 16];
const CSC = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const EDGE_PATHS = [join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')];

/**
 * The C# source of the launcher, with this computer's paths written in.
 *
 * Run without arguments it starts the service and the panel. Run as `共议.exe --tray OWNER_PID ICON TITLE WINDOW_TITLE`
 * it is the panel's taskbar icon (see tray.mjs): Windows remembers an icon's "show on the taskbar" choice per program,
 * so the icon belongs to this exe rather than to powershell.exe, which every restart would make a new, hidden icon.
 */
export function launcher_source({ node, local_script, panel_script, home }) {
  const text = value => `@"${String(value).replaceAll('"', '""')}"`;
  return `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("共议")]
[assembly: AssemblyProduct("AI CoDiscuss")]

static class Launcher {
  const string Node = ${text(node)};
  const string LocalScript = ${text(local_script)};
  const string PanelScript = ${text(panel_script)};
  const string Home = ${text(home)};

  [STAThread]
  static void Main(string[] args) {
    if (args.Length >= 5 && args[0] == "--tray") { Tray.Run(int.Parse(args[1]), args[2], args[3], args[4]); return; }
    if (!File.Exists(Node) || !File.Exists(LocalScript)) {
      MessageBox.Show("找不到 Node.js 或共议程序。请在命令行运行 codiscuss launcher 重新生成启动器。", "共议", MessageBoxButtons.OK, MessageBoxIcon.Warning);
      return;
    }
    Start(LocalScript, "open");
    if (PanelScript.Length > 0 && File.Exists(PanelScript)) Start(PanelScript, "start");
  }

  static void Start(string script, string command) {
    ProcessStartInfo info = new ProcessStartInfo(Node, "\\"" + script + "\\" " + command);
    info.UseShellExecute = false;
    info.CreateNoWindow = true;
    info.WorkingDirectory = Path.GetDirectoryName(script);
    info.EnvironmentVariables["DISCUSS_SERVICE_HOME"] = Home;
    Process.Start(info);
  }
}

/** The taskbar icon: reports each menu choice as one word on standard output to the panel process that started it. */
static class Tray {
  delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, int message, IntPtr kind, IntPtr icon);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);

  // Menu entries in order; an empty label is a separator.
  static readonly string[] Labels = { "打开管理面板", "打开共议", "", "重启服务", "关闭服务" };
  static ContextMenuStrip menu;

  static string panel;
  static Icon small, big;
  static DateTime asked = DateTime.MinValue;

  static void Say(string word) { Console.Out.WriteLine(word); Console.Out.Flush(); }

  static List<IntPtr> Windows() {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate (IntPtr window, IntPtr data) {
      StringBuilder text = new StringBuilder(256); GetWindowText(window, text, 256);
      if (text.ToString() == panel) found.Add(window);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // Bring the panel window forward (this process was just clicked, so Windows lets it), or ask for one; a window takes a
  // few seconds to appear, so a second click meanwhile does not ask again.
  static void OpenPanel() {
    List<IntPtr> windows = Windows();
    if (windows.Count > 0) {
      if (IsIconic(windows[0])) ShowWindow(windows[0], 9);
      SetForegroundWindow(windows[0]);
      return;
    }
    if ((DateTime.Now - asked).TotalSeconds < 10) return;
    asked = DateTime.Now;
    Say("open");
  }

  // Keep one panel window, carrying this icon: Edge lays a dark backing under the rounded corners of its own.
  static void Tend() {
    List<IntPtr> windows = Windows();
    for (int index = 1; index < windows.Count; index++) PostMessage(windows[index], 0x10, IntPtr.Zero, IntPtr.Zero);
    if (windows.Count > 0 && small != null && SendMessage(windows[0], 0x7F, IntPtr.Zero, IntPtr.Zero) != small.Handle) {
      SendMessage(windows[0], 0x80, IntPtr.Zero, small.Handle);
      SendMessage(windows[0], 0x80, (IntPtr)1, big.Handle);
    }
  }

  static void Choose(int id) {
    if (id == 1) OpenPanel();
    if (id == 2) Say("site");
    if (id == 4) Say("restart");
    // Closing everything asks first: a stray click must not take the owner's site and rooms down.
    if (id == 5 && MessageBox.Show("关闭共议服务？本机网站、讨论服务与管理面板都会停止，托管用户的实例不受影响。", "共议", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes) Say("stop");
  }

  public static void Run(int owner, string icon_path, string title, string window_title) {
    panel = window_title;
    // Sharp text on scaled screens: per-monitor awareness where Windows has it, system awareness otherwise.
    try { if (!SetProcessDpiAwarenessContext((IntPtr)(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }
    menu = TrayMenu.Build(Labels, Choose);
    NotifyIcon icon = new NotifyIcon();
    try {
      icon.Icon = new Icon(icon_path, SystemInformation.SmallIconSize);
      small = new Icon(icon_path, 16, 16);
      big = new Icon(icon_path, 32, 32);
    } catch { icon.Icon = SystemIcons.Application; }
    icon.Text = title.Length > 63 ? title.Substring(0, 63) : title;
    icon.MouseUp += delegate (object source, MouseEventArgs click) {
      if (click.Button == MouseButtons.Left) OpenPanel();
      if (click.Button == MouseButtons.Right) TrayMenu.Show(menu, Cursor.Position);
    };
    icon.Visible = true;
    Timer watch = new Timer();
    watch.Interval = 2000;
    watch.Tick += delegate {
      try { Process.GetProcessById(owner); } catch { Application.Exit(); return; }
      Tend();
    };
    watch.Start();
    Say("ready");
    Application.Run();
    icon.Visible = false;
    icon.Dispose();
  }
}
/** A Windows 11 style menu like other taskbar programs': roomy rows, a soft rounded highlight, light separators, rounded
 * window corners, opening up and to the right of the pointer. */
static class TrayMenu {
  const int Width = 180;
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);

  class Look : ToolStripRenderer {
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { e.Graphics.Clear(Color.FromArgb(249, 249, 249)); }
    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) { }
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
      if (!e.Item.Selected) return;
      Rectangle box = new Rectangle(5, 2, e.ToolStrip.ClientSize.Width - 10 - e.Item.Bounds.X, e.Item.Height - 4);
      using (GraphicsPath path = Rounded(box, 5)) using (SolidBrush fill = new SolidBrush(Color.FromArgb(234, 234, 234))) {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        e.Graphics.FillPath(fill, path);
      }
    }
    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
      e.TextColor = Color.FromArgb(26, 26, 26);
      base.OnRenderItemText(e);
    }
    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
      int middle = e.Item.Height / 2;
      using (Pen line = new Pen(Color.FromArgb(225, 225, 225))) e.Graphics.DrawLine(line, 12, middle, e.ToolStrip.ClientSize.Width - 14, middle);
    }
    static GraphicsPath Rounded(Rectangle box, int radius) {
      GraphicsPath path = new GraphicsPath(); int d = radius * 2;
      path.AddArc(box.X, box.Y, d, d, 180, 90); path.AddArc(box.Right - d, box.Y, d, d, 270, 90);
      path.AddArc(box.Right - d, box.Bottom - d, d, d, 0, 90); path.AddArc(box.X, box.Bottom - d, d, d, 90, 90);
      path.CloseFigure(); return path;
    }
  }

  // A blank row above and below the entries.
  static ToolStripLabel Gap() { ToolStripLabel gap = new ToolStripLabel(""); gap.AutoSize = false; gap.Height = 6; gap.Margin = Padding.Empty; gap.Enabled = false; return gap; }

  public static ContextMenuStrip Build(string[] labels, Action<int> chosen) {
    ContextMenuStrip strip = new ContextMenuStrip();
    strip.Renderer = new Look();
    strip.ShowImageMargin = false;
    strip.ShowCheckMargin = false;
    strip.Font = new Font("Microsoft YaHei UI", 9.5f);
    strip.Padding = new Padding(0, 2, 0, 2);
    strip.Items.Add(Gap());
    for (int index = 0; index < labels.Length; index++) {
      if (labels[index].Length == 0) { ToolStripSeparator line = new ToolStripSeparator(); line.AutoSize = false; line.Height = 13; strip.Items.Add(line); continue; }
      ToolStripMenuItem item = new ToolStripMenuItem(labels[index]);
      item.AutoSize = false;
      item.Size = new Size(Width, 34);
      item.TextAlign = ContentAlignment.MiddleLeft;
      item.Padding = new Padding(14, 0, 14, 0);
      item.Margin = Padding.Empty;
      int id = index + 1;
      item.Click += delegate { chosen(id); };
      strip.Items.Add(item);
    }
    strip.Items.Add(Gap());
    // Fixed size: ToolStrip would otherwise make the menu narrower than its rows and cut the highlight on the right.
    int height = 4;
    foreach (ToolStripItem row in strip.Items) height += row.Height;
    strip.AutoSize = false;
    strip.Size = new Size(Width + 2, height);
    strip.HandleCreated += delegate { int round = 2; DwmSetWindowAttribute(strip.Handle, 33, ref round, 4); };
    return strip;
  }

  public static void Show(ContextMenuStrip strip, Point at) {
    // Opened downward from one menu-height above the pointer, so it sits up and to the right of it.
    strip.Show(new Point(at.X, at.Y - strip.Height), ToolStripDropDownDirection.BelowRight);
    // A menu closes on an outside click only when this program is in the foreground.
    SetForegroundWindow(strip.Handle);
  }
}
`;
}

/** Wrap PNG images into one .ico file (Windows Vista and later read PNG entries of any size). */
export function ico_from_pngs(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry); header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

/** The light product mark on a white rounded tile, as the panel's window icon shows it. */
function tile_svg() {
  return readFileSync(join(ROOT, 'web', 'mark-tile.svg'), 'utf8');
}

/**
 * Draw the icon in every size with Edge in headless mode, which renders the SVG mark exactly; each size is drawn on its
 * own rather than scaled down, so small sizes stay sharp.
 */
function render_icon(folder) {
  const edge = EDGE_PATHS.find(path => existsSync(path));
  if (!edge) return null;
  const work = join(tmpdir(), `codiscuss-icon-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    const svg = tile_svg();
    const images = ICON_SIZES.map(size => {
      const page = join(work, `icon-${size}.html`), png = join(work, `icon-${size}.png`);
      writeFileSync(page, `<!doctype html><html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
      spawnSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(work, 'profile')}`, '--default-background-color=00000000',
        `--window-size=${size},${size}`, `--screenshot=${png}`, `file:///${page.replaceAll('\\', '/')}`], { windowsHide: true, timeout: 60_000 });
      return existsSync(png) ? { size, png: readFileSync(png) } : null;
    });
    if (images.some(image => !image)) return null;
    const path = join(folder, 'codiscuss.ico');
    writeFileSync(path, ico_from_pngs(images));

    return path;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** The local-service script to start: the installed codiscuss package's, falling back to this source tree's. */
function installed_script(name) {
  const found = spawnSync('where.exe', ['codiscuss.cmd'], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/).find(Boolean);
  const installed = found && join(dirname(found), 'node_modules', 'ai_co_discuss', 'runner', name);
  return installed && existsSync(installed) ? installed : join(RUNNER, name);
}

/** Put a shortcut to the exe in a special folder (Desktop or Programs); values pass through the environment. */
function write_shortcut(folder, exe, icon) {
  const script = "$d=[Environment]::GetFolderPath($env:SC_FOLDER); $p=Join-Path $d $env:SC_NAME;"
    + " $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); $s.TargetPath=$env:SC_TARGET; $s.WorkingDirectory=$env:SC_CWD;"
    + " if ($env:SC_ICON) { $s.IconLocation=$env:SC_ICON }; $s.Description='启动共议'; $s.Save(); Write-Output $p";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, SC_FOLDER: folder, SC_NAME: SHORTCUT_NAME, SC_TARGET: exe, SC_CWD: dirname(exe), SC_ICON: icon || '' } });
  if (result.status !== 0) throw new Error(`创建快捷方式失败：${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Build 共议.exe and its shortcuts.
 *
 * Returns:
 *   { exe, icon, shortcuts }.
 */
export function install_launcher(home = join(homedir(), '.codiscuss')) {
  if (process.platform !== 'win32') throw new Error('启动器仅支持 Windows');
  if (!existsSync(CSC)) throw new Error(`找不到 .NET Framework 自带的 C# 编译器：${CSC}`);
  const folder = join(home, 'launcher');
  mkdirSync(folder, { recursive: true });
  const icon = render_icon(folder);
  const source = join(folder, 'launcher.cs'), exe = join(folder, EXE_NAME);
  writeFileSync(source, `\ufeff${launcher_source({ node: process.execPath, local_script: installed_script('discussion_local.mjs'),
    panel_script: existsSync(join(ROOT, 'gateway', 'gateway.mjs')) ? join(RUNNER, 'admin_panel.mjs') : '', home })}`, 'utf8');
  const result = spawnSync(CSC, ['/nologo', '/target:winexe', '/codepage:65001', '/optimize+', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    `/out:${exe}`, ...(icon ? [`/win32icon:${icon}`] : []), source], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`编译启动器失败：${(result.stdout || result.stderr).trim()}`);
  const shortcuts = ['Desktop', 'Programs'].map(place => write_shortcut(place, exe, icon));
  return { exe, icon, shortcuts };
}

export function launcher_main() {
  const { exe, icon, shortcuts } = install_launcher();
  process.stdout.write(`已生成启动器：${exe}\n${icon ? '' : '（没有找到 Edge，启动器使用默认图标）\n'}快捷方式：\n${shortcuts.map(path => `  ${path}`).join('\n')}\n双击即可启动共议。\n`);
}
