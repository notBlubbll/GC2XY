using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class TrayHostForm : Form
{
    private NotifyIcon trayIcon;
    private Timer pollTimer;
    private Process child;
    private string expectedTitle;

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    const int SW_HIDE = 0;
    const int SW_SHOW = 5;
    const int SW_RESTORE = 9;

    public TrayHostForm()
    {
        if (!Environment.UserInteractive)
        {
            Environment.Exit(0);
        }

        Size = new Size(1, 1);
        WindowState = FormWindowState.Minimized;
        ShowInTaskbar = false;
        FormBorderStyle = FormBorderStyle.None;
        Visible = false;

        expectedTitle = Environment.GetEnvironmentVariable("TRAY_WATCH_TITLE");
        if (string.IsNullOrEmpty(expectedTitle)) expectedTitle = "gc2xy";

        trayIcon = new NotifyIcon();
        trayIcon.Text = expectedTitle;
        trayIcon.Icon = SystemIcons.Application;
        trayIcon.Visible = true;
        trayIcon.DoubleClick += new EventHandler((s, e) => ToggleWindow());
        trayIcon.ContextMenuStrip = new ContextMenuStrip();
        trayIcon.ContextMenuStrip.Items.Add("Show / Hide", null, new EventHandler((s, e) => ToggleWindow()));
        trayIcon.ContextMenuStrip.Items.Add("Open Dashboard", null, new EventHandler((s, e) => OpenDashboard()));
        trayIcon.ContextMenuStrip.Items.Add(new ToolStripSeparator());
        trayIcon.ContextMenuStrip.Items.Add("Exit", null, new EventHandler((s, e) => ExitApp()));

        string cmd = GetCommand();
        string arguments = Environment.GetEnvironmentVariable("TRAY_WATCH_ARGS");
        if (arguments == null) arguments = "";
        string workDir = Environment.GetEnvironmentVariable("TRAY_WATCH_DIR");
        if (string.IsNullOrEmpty(workDir))
            workDir = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);

        if (!File.Exists(cmd))
        {
            Environment.Exit(2);
            return;
        }

        Environment.SetEnvironmentVariable("gc2xy_TRAY_DONE", "1");

        child = new Process();
        child.StartInfo.FileName = cmd;
        child.StartInfo.Arguments = arguments;
        child.StartInfo.WorkingDirectory = workDir;
        child.StartInfo.UseShellExecute = false;
        child.StartInfo.CreateNoWindow = false;
        child.EnableRaisingEvents = true;
        child.Exited += new EventHandler((s, e) =>
        {
            try { Application.Exit(); } catch { }
        });
        child.Start();

        pollTimer = new Timer();
        pollTimer.Interval = 250;
        pollTimer.Tick += new EventHandler((s, e) => WatchChild());
        pollTimer.Start();
    }

    static string GetCommand()
    {
        string[] args = Environment.GetCommandLineArgs();
        if (args.Length > 1 && !string.IsNullOrEmpty(args[1]))
            return args[1];

        string env = Environment.GetEnvironmentVariable("TRAY_WATCH_CMD");
        if (!string.IsNullOrEmpty(env))
            return env;

        string baseDir = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
        return Path.Combine(baseDir, "service-mock.exe");
    }

    void WatchChild()
    {
        if (child == null || child.HasExited)
        {
            ExitApp();
            return;
        }
        child.Refresh();
        IntPtr hWnd = child.MainWindowHandle;
        if (hWnd == IntPtr.Zero)
            hWnd = FindWindowByTitle(expectedTitle);
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd))
            return;
        if (IsIconic(hWnd))
        {
            ShowWindow(hWnd, SW_HIDE);
        }
    }

    IntPtr FindWindowByTitle(string title)
    {
        foreach (Process p in Process.GetProcesses())
        {
            try
            {
                if (p.MainWindowHandle != IntPtr.Zero)
                {
                    string t = p.MainWindowTitle;
                    if (t != null && t.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0)
                        return p.MainWindowHandle;
                }
            }
            catch { }
        }
        return IntPtr.Zero;
    }

    void ToggleWindow()
    {
        if (child == null || child.HasExited)
            return;
        child.Refresh();
        IntPtr hWnd = child.MainWindowHandle;
        if (hWnd == IntPtr.Zero)
            hWnd = FindWindowByTitle(expectedTitle);
        if (hWnd == IntPtr.Zero)
            return;
        if (!IsWindowVisible(hWnd) || IsIconic(hWnd))
        {
            ShowWindow(hWnd, SW_RESTORE);
            ShowWindow(hWnd, SW_SHOW);
            SetForegroundWindow(hWnd);
        }
        else
        {
            ShowWindow(hWnd, SW_HIDE);
        }
    }

    void OpenDashboard()
    {
        try
        {
            Process.Start(new ProcessStartInfo("https://github.com/dashboard") { UseShellExecute = true });
        }
        catch { }
    }

    void ExitApp()
    {
        if (pollTimer != null)
        {
            pollTimer.Stop();
            pollTimer.Dispose();
            pollTimer = null;
        }
        if (trayIcon != null)
        {
            trayIcon.Visible = false;
            trayIcon.Dispose();
            trayIcon = null;
        }
        try
        {
            if (child != null && !child.HasExited)
                child.Kill();
        }
        catch { }
        Application.Exit();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        ExitApp();
        base.OnFormClosing(e);
    }

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayHostForm());
    }
}
