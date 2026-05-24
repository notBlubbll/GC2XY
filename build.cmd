@echo off
setlocal enabledelayedexpansion

echo ================================================
echo  gc2xy - Build System
echo  Auto-detects Bun or Node.js to create a
echo  portable .dist with Windows Service support.
echo ================================================
echo.

:: -- Check entry point --
if not exist src\mitm-proxy.ts (
    echo [ERROR] src\mitm-proxy.ts not found
    endlocal
    exit /b 1
)

:: -- Auto-detect runtime --
where bun >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Bun detected -- running Bun build...
    echo.
    call build-bun.cmd
    endlocal
    exit /b !ERRORLEVEL!
)

where node >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Node.js detected -- running Node.js build...
    echo.
    call build-node.cmd
    endlocal
    exit /b !ERRORLEVEL!
)

echo [ERROR] Neither Bun nor Node.js found.
echo Please install Bun (https://bun.sh) or Node.js (https://nodejs.org)
endlocal
exit /b 1

:: -- Embedded C# service wrapper (referenced by PowerShell extraction) --

===CS_START===
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.ServiceProcess;
using System.Threading;

class ServiceWrapper
{
    public static volatile bool stopping;
    static Process currentProc;
    static string appId;
    static string mode;

    static int Main(string[] args)
    {
        Environment.SetEnvironmentVariable("gc2xy_WRAPPED", "1");
        appId = GetAppId();
        mode = GetMode();

        if (!Environment.UserInteractive)
        {
            ServiceBase.Run(new gc2xyService());
            return 0;
        }

        SafeSetTitle("gc2xy - " + mode.ToUpper());
        StopExistingInstances();

        // Auto-detect Windows Terminal: relaunch in WT unless ENFORCE_CMD=1 or already in WT
        if (TryLaunchInWT())
            return 0;

        return RunServerLoop(interactive: true);
    }

    public static string GetAppId()
    {
        string name = Environment.GetEnvironmentVariable("gc2xy_SERVICE_NAME");
        if (!string.IsNullOrEmpty(name)) return name;
        try
        {
            using (var p = Process.GetCurrentProcess())
            {
                string procPath = p.MainModule.FileName;
                if (!string.IsNullOrEmpty(procPath))
                    return Path.GetFileNameWithoutExtension(procPath);
            }
        }
        catch { }
        try
        {
            return Path.GetFileNameWithoutExtension(
                Assembly.GetEntryAssembly().Location);
        }
        catch { return "gc2xy"; }
    }

    public static string GetMode()
    {
        string id = appId.ToLowerInvariant();
        if (id.Contains("proxy")) return "proxy";
        if (id.Contains("hybrid")) return "hybrid";
        return "mock";
    }

static void StopExistingInstances()
{
    // Kill any existing gc2xy or matching node processes
    string[] procNames = { "gc2xy", "node", "bun" };
    foreach (string name in procNames)
    {
        try
        {
            foreach (var p in Process.GetProcessesByName(name))
            {
                try
                {
                    if (!p.HasExited)
                    {
                        Log("[INFO] Killing existing " + name + " instance (pid " + p.Id + ")...");
                        p.Kill();
                        p.WaitForExit(3000);
                    }
                }
                catch { }
            }
        }
        catch { }
    }

    // Free ports 80 and 443
    int[] ports = { 80, 443 };
    foreach (int port in ports)
    {
        for (int i = 0; i < 4; i++)
        {
            KillPortProcess(port);
            Thread.Sleep(1000);
        }
    }
}

    public static int RunServerLoop(bool interactive)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        stopping = false;

        while (!stopping)
        {
            if (interactive) SafeClear();
            LoadEnv(baseDir);

            int exitCode = TryLaunchServer(baseDir, interactive);

            if (stopping) break;

            // Handle mode-switch exit codes
            if (exitCode == 45) // Switch to PROXY
            {
                mode = "proxy";
                SafeSetTitle("gc2xy - PROXY");
                continue;
            }
            if (exitCode == 44) // Switch to HYBRID
            {
                mode = "hybrid";
                SafeSetTitle("gc2xy - HYBRID");
                continue;
            }
            if (exitCode == 43) // Switch to MOCK
            {
                mode = "mock";
                SafeSetTitle("gc2xy - MOCK");
                continue;
            }
            if (exitCode == 42) // Restart same mode
                continue;

            if (exitCode == 0 || exitCode == -1)
                return exitCode;

            return exitCode;
        }
        return 0;
    }

    static int TryLaunchServer(string baseDir, bool interactive)
    {
        // 1. Bun standalone (gc2xy binary next to service.exe)
        string gc2xyPath = Path.Combine(baseDir, "gc2xy");
        if (File.Exists(gc2xyPath))
        {
            if (interactive) Log("[INFO] Runtime: Bun (standalone)");
            if (interactive) Log("");
            return RunProcessTracked(gc2xyPath, "", baseDir);
        }

        // 2. Node.js portable (node binary next to service.exe + tsx)
        string nodePath = Path.Combine(baseDir, "node");
        if (File.Exists(nodePath))
        {
            string tsxCli = Path.Combine(baseDir, "node_modules", "tsx", "dist", "esm", "cli.mjs");
            string srcPath = Path.Combine(baseDir, "src", "mitm-proxy.ts");
            if (File.Exists(tsxCli) && File.Exists(srcPath))
            {
                if (interactive) Log("[INFO] Runtime: Node.js (portable + tsx)");
                if (interactive) Log("");
                string args = "\"" + tsxCli + "\" \"" + srcPath + "\"";
                return RunProcessTracked(nodePath, args, baseDir);
            }
        }

        // 3. Bun from PATH (run from source)
        string bunPath = FindExe("bun");
        if (bunPath != null)
        {
            string srcPath = Path.Combine(baseDir, "src", "mitm-proxy.ts");
            if (File.Exists(srcPath))
            {
                if (interactive) Log("[INFO] Runtime: Bun (from PATH)");
                if (interactive) Log("");
                return RunProcessTracked(bunPath, "run src/mitm-proxy.ts", baseDir);
            }
        }

        // 4. Node.js from PATH (with tsx)
        string nodePath2 = FindExe("node");
        if (nodePath2 != null)
        {
            string tsxCli = Path.Combine(baseDir, "node_modules", "tsx", "dist", "esm", "cli.mjs");
            string srcPath = Path.Combine(baseDir, "src", "mitm-proxy.ts");
            if (File.Exists(tsxCli) && File.Exists(srcPath))
            {
                if (interactive) Log("[INFO] Runtime: Node.js (from PATH + tsx)");
                if (interactive) Log("");
                string args = "\"" + tsxCli + "\" \"" + srcPath + "\"";
                return RunProcessTracked(nodePath2, args, baseDir);
            }
        }

        if (interactive)
        {
            LogErr("[ERROR] No runtime found in " + baseDir);
            LogErr("       Expected: gc2xy (Bun standalone) or node + src/ (Node.js + tsx)");
            Log("Press any key to exit...");
            try { Console.ReadKey(true); } catch { }
        }
        return -1;
    }

    static int RunProcessTracked(string exe, string args, string workDir)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            Arguments = args,
            WorkingDirectory = workDir,
            UseShellExecute = false,
        };

        // Set environment variables for the selected mode
        psi.EnvironmentVariables["gc2xy_MODE"] = mode;
        if (mode == "proxy")
        {
            psi.EnvironmentVariables["PASSTHROUGH"] = "1";
            psi.EnvironmentVariables["HYBRID_MODE"] = "";
            psi.EnvironmentVariables["FAKE_DEVICE_LOGIN"] = "";
            psi.EnvironmentVariables["SKIP_CACHE"] = "";
        }
        else if (mode == "hybrid")
        {
            psi.EnvironmentVariables["PASSTHROUGH"] = "";
            psi.EnvironmentVariables["HYBRID_MODE"] = "1";
            psi.EnvironmentVariables["FAKE_DEVICE_LOGIN"] = "1";
            psi.EnvironmentVariables["SKIP_CACHE"] = "1";
        }
        else // mock
        {
            psi.EnvironmentVariables["PASSTHROUGH"] = "";
            psi.EnvironmentVariables["HYBRID_MODE"] = "";
            psi.EnvironmentVariables["FAKE_DEVICE_LOGIN"] = "1";
            psi.EnvironmentVariables["SKIP_CACHE"] = "1";
        }

        currentProc = Process.Start(psi);
        if (currentProc == null) return -1;
        currentProc.WaitForExit();
        int code = currentProc.ExitCode;
        currentProc = null;
        return code;
    }

    public static void KillServerProcess()
    {
        try
        {
            if (currentProc != null && !currentProc.HasExited)
            {
                currentProc.Kill();
                currentProc.WaitForExit(5000);
            }
        }
        catch { }
    }

    static void SafeClear() { try { Console.Clear(); } catch { } }
    static void SafeSetTitle(string t) { try { Console.Title = t; } catch { } }
    static void Log(string msg) { try { Console.WriteLine(msg); } catch { } }
    static void LogErr(string msg) { try { Console.Error.WriteLine(msg); } catch { } }

    static string FindExe(string name)
    {
        try
        {
            string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in pathVar.Split(Path.PathSeparator))
            {
                string full = Path.Combine(dir, name + ".exe");
                if (File.Exists(full)) return full;
            }
        }
        catch { }
        return null;
    }

    static bool TryLaunchInWT()
    {
        // Already inside Windows Terminal
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WT_SESSION")))
            return false;

        // User explicitly wants plain cmd.exe
        if (Environment.GetEnvironmentVariable("ENFORCE_CMD") == "1")
            return false;

        // Find wt.exe (PATH or WindowsApps alias)
        string wtPath = FindExe("wt");
        if (string.IsNullOrEmpty(wtPath))
            return false;

        try
        {
            string exePath = Process.GetCurrentProcess().MainModule.FileName;
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var psi = new ProcessStartInfo
            {
                FileName = wtPath,
                Arguments = "new-tab --title \"gc2xy - " + mode.ToUpper() + "\" --startingDirectory \"" + baseDir + "\" cmd /k \"\\\"" + exePath + "\\\"\"",
                UseShellExecute = true,
            };
            Process.Start(psi);
            return true;
        }
        catch { }
        return false;
    }

    static void LoadEnv(string baseDir)
    {
        string envPath = Path.Combine(baseDir, ".env");
        if (!File.Exists(envPath)) return;
        foreach (string rawLine in File.ReadAllLines(envPath))
        {
            string line = rawLine.Trim();
            if (string.IsNullOrEmpty(line) || line.StartsWith("#"))
                continue;
            int eqIdx = line.IndexOf('=');
            if (eqIdx > 0)
            {
                string key = line.Substring(0, eqIdx).Trim();
                string value = line.Substring(eqIdx + 1).Trim();
                Environment.SetEnvironmentVariable(key, value);
            }
        }
    }

    static void KillPortProcess(int port)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c netstat -ano | findstr \":" + port + " \" | findstr \"LISTENING\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };

            var proc = Process.Start(psi);
            string output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit();

            if (string.IsNullOrWhiteSpace(output))
                return;

            var seenPids = new HashSet<int>();
            foreach (string line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string[] parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 5)
                {
                    int pid;
                    if (int.TryParse(parts[parts.Length - 1], out pid) && pid > 0)
                    {
                        if (seenPids.Add(pid))
                        {
                            try
                            {
                                var killPsi = new ProcessStartInfo
                                {
                                    FileName = "taskkill.exe",
                                    Arguments = "/pid " + pid + " /f",
                                    UseShellExecute = false,
                                    RedirectStandardOutput = true,
                                    RedirectStandardError = true,
                                    CreateNoWindow = true,
                                };
                                var killProc = Process.Start(killPsi);
                                killProc.WaitForExit();
                            }
                            catch { }
                        }
                    }
                }
            }
        }
        catch { }
    }
}

class gc2xyService : ServiceBase
{
    private Thread serverThread;

    public gc2xyService()
    {
        ServiceName = ServiceWrapper.GetAppId();
        CanStop = true;
        CanPauseAndContinue = false;
        AutoLog = true;
    }

    protected override void OnStart(string[] args)
    {
        serverThread = new Thread(() => ServiceWrapper.RunServerLoop(interactive: false));
        serverThread.IsBackground = true;
        serverThread.Start();
    }

    protected override void OnStop()
    {
        ServiceWrapper.stopping = true;
        ServiceWrapper.KillServerProcess();
        if (serverThread != null && serverThread.IsAlive)
            serverThread.Join(15000);
    }
}
===CS_END===
