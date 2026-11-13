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
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);

  // Menu entries in order; an empty label is a separator. Without a panel ("-" for its window title) the first is left out.
  static readonly string[] Labels = { "打开管理面板", "打开共议", "", "重启服务", "关闭服务" };
  static ContextMenuStrip menu;
  static bool has_panel;

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

  // Bring a window forward. Windows may refuse SetForegroundWindow to a taskbar icon's program even right after its click,
  // leaving the window behind the others; sharing input with the program in front (the taskbar) makes it allowed.
  static void Raise(IntPtr window) {
    ShowWindow(window, IsIconic(window) ? 9 : 5);
    uint mine = GetCurrentThreadId(), front = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    bool attached = front != 0 && front != mine && AttachThreadInput(front, mine, true);
    BringWindowToTop(window);
    SetForegroundWindow(window);
    if (attached) AttachThreadInput(front, mine, false);
  }

  // Bring the panel window forward, or ask for one; a new window takes a few seconds to appear, so a click meanwhile does
  // not ask again.
  static void OpenPanel() {
    List<IntPtr> windows = Windows();
    if (windows.Count > 0) { Raise(windows[0]); return; }
    if ((DateTime.Now - asked).TotalSeconds < 5) return;
    asked = DateTime.Now;
    Say("open");
  }

  // Keep one panel window, carrying this icon: Edge lays a dark backing under the rounded corners of its own.
  static void Tend() {
    if (!has_panel) return;
    List<IntPtr> windows = Windows();
    for (int index = 1; index < windows.Count; index++) PostMessage(windows[index], 0x10, IntPtr.Zero, IntPtr.Zero);
    if (windows.Count > 0 && small != null && SendMessage(windows[0], 0x7F, IntPtr.Zero, IntPtr.Zero) != small.Handle) {
      SendMessage(windows[0], 0x80, IntPtr.Zero, small.Handle);
      SendMessage(windows[0], 0x80, (IntPtr)1, big.Handle);
    }
  }

  static void Choose(string label) {
    if (label == "打开管理面板") OpenPanel();
    if (label == "打开共议") Say("site");
    if (label == "重启服务") Say("restart");
    // Closing everything asks first: a stray click must not take the owner's site and rooms down.
    if (label == "关闭服务" && Confirm.Ask("关闭共议服务？", "本机网站、讨论服务与管理面板都会停止。" + Environment.NewLine + "托管用户的实例不受影响。", "关闭服务", "取消")) Say("stop");
  }

  public static void Run(int owner, string icon_path, string title, string window_title) {
    panel = window_title;
    has_panel = window_title != "-";
    // Sharp text on scaled screens: per-monitor awareness where Windows has it, system awareness otherwise.
    try { if (!SetProcessDpiAwarenessContext((IntPtr)(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }
    List<string> labels = new List<string>(Labels);
    if (!has_panel) labels.Remove("打开管理面板");
    menu = TrayMenu.Build(labels.ToArray(), Choose);
    NotifyIcon icon = new NotifyIcon();
    try {
      icon.Icon = new Icon(icon_path, SystemInformation.SmallIconSize);
      small = new Icon(icon_path, 16, 16);
      big = new Icon(icon_path, 32, 32);
    } catch { icon.Icon = SystemIcons.Application; }
    icon.Text = title.Length > 63 ? title.Substring(0, 63) : title;
    icon.MouseUp += delegate (object source, MouseEventArgs click) {
      if (click.Button == MouseButtons.Left) { if (has_panel) OpenPanel(); else Say("site"); }
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
  }

  public static GraphicsPath Rounded(Rectangle box, int radius) {
    GraphicsPath path = new GraphicsPath(); int d = radius * 2;
    path.AddArc(box.X, box.Y, d, d, 180, 90); path.AddArc(box.Right - d, box.Y, d, d, 270, 90);
    path.AddArc(box.Right - d, box.Bottom - d, d, d, 0, 90); path.AddArc(box.X, box.Bottom - d, d, d, 90, 90);
    path.CloseFigure(); return path;
  }

  // A blank row above and below the entries.
  static ToolStripLabel Gap() { ToolStripLabel gap = new ToolStripLabel(""); gap.AutoSize = false; gap.Height = 6; gap.Margin = Padding.Empty; gap.Enabled = false; return gap; }

  public static ContextMenuStrip Build(string[] labels, Action<string> chosen) {
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
      string label = labels[index];
      item.Click += delegate { chosen(label); };
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

/** A confirmation in the same Windows 11 look as the menu: a heading, one line of detail, and a footer with two rounded
 * buttons. The safe button holds the focus, so Enter or Esc cancels. */
static class Confirm {
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

  // No title bar, like the menu; the class style adds the shadow a borderless window lacks.
  class Sheet : Form {
    protected override CreateParams CreateParams { get { CreateParams p = base.CreateParams; p.ClassStyle |= 0x20000; return p; } }
  }

  class Pill : Button {
    readonly bool primary; readonly int radius; bool over, down;
    public Pill(string text, bool primary, int radius) {
      Text = text; this.primary = primary; this.radius = radius;
      SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
    }
    protected override void OnMouseEnter(EventArgs e) { over = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { over = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnPaint(PaintEventArgs e) {
      Graphics g = e.Graphics;
      g.Clear(Parent.BackColor);
      g.SmoothingMode = SmoothingMode.AntiAlias;
      Color fill = primary ? (down ? Color.FromArgb(51, 127, 198) : over ? Color.FromArgb(25, 111, 192) : Color.FromArgb(0, 95, 184))
        : (down ? Color.FromArgb(245, 245, 245) : over ? Color.FromArgb(246, 246, 246) : Color.FromArgb(251, 251, 251));
      using (GraphicsPath path = TrayMenu.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), radius)) {
        using (SolidBrush brush = new SolidBrush(fill)) g.FillPath(brush, path);
        if (!primary) using (Pen edge = new Pen(Color.FromArgb(229, 229, 229))) g.DrawPath(edge, path);
      }
      if (Focused && ShowFocusCues) using (GraphicsPath ring = TrayMenu.Rounded(new Rectangle(1, 1, Width - 3, Height - 3), radius)) using (Pen pen = new Pen(Color.FromArgb(26, 26, 26), 2)) g.DrawPath(pen, ring);
      Color ink = primary ? Color.White : down ? Color.FromArgb(93, 93, 93) : Color.FromArgb(26, 26, 26);
      TextRenderer.DrawText(g, Text, Font, ClientRectangle, ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }
  }

  public static bool Ask(string heading, string detail, string yes, string no) {
    using (Form form = new Sheet()) {
      float scale; using (Graphics probe = Graphics.FromHwnd(IntPtr.Zero)) scale = probe.DpiX / 96f;
      Func<int, int> px = value => (int)Math.Round(value * scale);
      form.Text = "共议";
      form.FormBorderStyle = FormBorderStyle.None;
      form.ShowInTaskbar = false; form.TopMost = true;
      form.StartPosition = FormStartPosition.CenterScreen;
      form.AutoScaleMode = AutoScaleMode.None;
      form.BackColor = Color.White;
      form.Font = new Font("Microsoft YaHei UI", 9.5f);
      form.ClientSize = new Size(px(420), px(196));

      Label title = new Label();
      title.Text = heading; title.Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold); title.ForeColor = Color.FromArgb(26, 26, 26);
      title.AutoSize = true; title.Location = new Point(px(24), px(26));
      Label body = new Label();
      body.Text = detail; body.ForeColor = Color.FromArgb(96, 96, 96);
      body.AutoSize = false; body.Location = new Point(px(24), px(68)); body.Size = new Size(px(372), px(48));

      Panel footer = new Panel();
      footer.Dock = DockStyle.Bottom; footer.Height = px(76); footer.BackColor = Color.FromArgb(243, 243, 243);
      footer.Paint += delegate (object source, PaintEventArgs e) {
        using (Pen line = new Pen(Color.FromArgb(229, 229, 229))) e.Graphics.DrawLine(line, 0, 0, footer.Width, 0);
      };
      int width = (px(420) - px(24) * 2 - px(8)) / 2;
      Pill accept = new Pill(yes, true, px(4)); accept.DialogResult = DialogResult.Yes;
      Pill cancel = new Pill(no, false, px(4)); cancel.DialogResult = DialogResult.No;
      accept.Bounds = new Rectangle(px(24), px(22), width, px(32));
      cancel.Bounds = new Rectangle(px(24) + width + px(8), px(22), width, px(32));
      footer.Controls.Add(accept); footer.Controls.Add(cancel);

      form.Controls.Add(title); form.Controls.Add(body); form.Controls.Add(footer);
      form.CancelButton = cancel;
      form.Shown += delegate { int round = 2; DwmSetWindowAttribute(form.Handle, 33, ref round, 4); form.Activate(); cancel.Focus(); };
      return form.ShowDialog() == DialogResult.Yes;
    }
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

/** Where the launcher of a service home lives. */
export function launcher_path(home = join(homedir(), '.codiscuss')) {
  return join(home, 'launcher', EXE_NAME);
}

/** Whether the launcher and its desktop shortcut both exist; the desktop is asked of Windows, as it may be redirected. */
export function launcher_installed(home = join(homedir(), '.codiscuss')) {
  if (!existsSync(launcher_path(home))) return false;
  const desktop = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
  return Boolean(desktop) && existsSync(join(desktop, SHORTCUT_NAME));
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
  const source = join(folder, 'launcher.cs'), exe = launcher_path(home);
  writeFileSync(source, `\ufeff${launcher_source({ node: process.execPath, local_script: installed_script('discussion_local.mjs'),
    panel_script: installed_script('admin_panel.mjs'), home })}`, 'utf8');
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
