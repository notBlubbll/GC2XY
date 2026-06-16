@echo off
setlocal enabledelayedexpansion

echo ================================================
echo  gc2xy - Build (Bun standalone)
echo  Compiles TypeScript to a single .exe binary.
echo ================================================
echo.

:: -- Check for Bun --
where bun >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Bun not found. Install from https://bun.sh
    endlocal
    exit /b 1
)

:: -- Check entry point --
if not exist src\mitm-proxy.ts (
    echo [ERROR] src\mitm-proxy.ts not found
    endlocal
    exit /b 1
)

if exist .dist rmdir /s /q .dist >nul 2>&1
if exist .dist (
    del /f /s /q .dist\* >nul 2>&1
    rmdir /s /q .dist >nul 2>&1
)
mkdir .dist 2>nul
if not exist .dist mkdir .dist
mkdir .dist\src 2>nul
if not exist .dist\src mkdir .dist\src

:: -- Step 1: Install dependencies --
if not exist node_modules (
    echo [1/5] Installing dependencies...
    call bun install
    if !ERRORLEVEL! neq 0 (
        echo [ERROR] bun install failed
        endlocal
        exit /b 1
    )
) else (
    echo [1/5] Dependencies already installed
)

:: -- Step 2: Build Bun standalone --
echo [2/5] Building gc2xy.exe (Bun standalone)...
bun build --compile --target bun-windows-x64 src\mitm-proxy.ts --outfile .dist\gc2xy.exe
if !ERRORLEVEL! neq 0 (
    echo [WARN] Baseline target failed, trying modern...
    bun build --compile --target bun-windows-x64-modern src\mitm-proxy.ts --outfile .dist\gc2xy.exe
)
if not exist .dist\gc2xy.exe (
    echo [ERROR] Bun build failed
    endlocal
    exit /b 1
)

:: Rename to gc2xy (no extension)
move /y .dist\gc2xy.exe .dist\gc2xy >nul

:: Copy .env and .config if present
if exist .env copy /y .env .dist\ >nul
if exist .config xcopy /s /i /q /y .config .dist\.config >nul 2>&1
:: Create .dist\.certs and copy existing certs
mkdir .dist\.certs 2>nul
if exist certs xcopy /s /i /q /y certs .dist\.certs >nul 2>&1
if exist .certs xcopy /s /i /q /y .certs .dist\.certs >nul 2>&1

:: Compile tray watcher if sources exist / no compiled exe yet
if exist src\tray-watcher.cs (
    copy /y src\tray-watcher.cs .dist\src\tray-watcher.cs >nul 2>&1
    if not exist .dist\gc2xy-tray.exe (
        if exist "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
            "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:anycpu /out:.dist\gc2xy-tray.exe .dist\src\tray-watcher.cs >nul 2>&1
        ) else if exist "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
            "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" /nologo /target:winexe /platform:anycpu /out:.dist\gc2xy-tray.exe .dist\src\tray-watcher.cs >nul 2>&1
        )
    )
)

:: -- Step 3: Create start scripts --
echo [3/5] Creating mode-specific launchers...

:: Generate .dist start scripts with Windows Terminal auto-detect (same logic as !ACTIVATE.cmd)
echo @echo off > .dist\start-mock.cmd
echo setlocal >> .dist\start-mock.cmd
echo. >> .dist\start-mock.cmd
echo :: Load .env if present >> .dist\start-mock.cmd
echo if exist "%%~dp0.config\.env" for /f "usebackq delims=" %%%%x in ("%%~dp0.config\.env") do set "%%%%x" 2^>nul >> .dist\start-mock.cmd
echo. >> .dist\start-mock.cmd
echo :: Windows Terminal auto-detect (unless ENFORCE_CMD=1) >> .dist\start-mock.cmd
echo if "%%ENFORCE_CMD%%"=="1" goto :run_direct >> .dist\start-mock.cmd
echo where wt.exe ^>nul 2^>^&1 >> .dist\start-mock.cmd
echo if errorlevel 1 goto :run_direct >> .dist\start-mock.cmd
echo if not "%%WT_SESSION%%"=="" goto :run_direct >> .dist\start-mock.cmd
echo. >> .dist\start-mock.cmd
echo :: Relaunch in Windows Terminal >> .dist\start-mock.cmd
echo wt.exe new-tab --title "gc2xy - MOCK" cmd /k cd /d "%%~dp0" ^&^& "%%~dp0service-mock.exe" >> .dist\start-mock.cmd
echo exit /b 0 >> .dist\start-mock.cmd
echo. >> .dist\start-mock.cmd
echo :run_direct >> .dist\start-mock.cmd
echo "%%~dp0service-mock.exe" >> .dist\start-mock.cmd

:: HYBRID
echo @echo off > .dist\start-hybrid.cmd
echo setlocal >> .dist\start-hybrid.cmd
echo. >> .dist\start-hybrid.cmd
echo :: Load .env if present >> .dist\start-hybrid.cmd
echo if exist "%%~dp0.config\.env" for /f "usebackq delims=" %%%%x in ("%%~dp0.config\.env") do set "%%%%x" 2^>nul >> .dist\start-hybrid.cmd
echo. >> .dist\start-hybrid.cmd
echo :: Windows Terminal auto-detect (unless ENFORCE_CMD=1) >> .dist\start-hybrid.cmd
echo if "%%ENFORCE_CMD%%"=="1" goto :run_direct >> .dist\start-hybrid.cmd
echo where wt.exe ^>nul 2^>^&1 >> .dist\start-hybrid.cmd
echo if errorlevel 1 goto :run_direct >> .dist\start-hybrid.cmd
echo if not "%%WT_SESSION%%"=="" goto :run_direct >> .dist\start-hybrid.cmd
echo. >> .dist\start-hybrid.cmd
echo :: Relaunch in Windows Terminal >> .dist\start-hybrid.cmd
echo wt.exe new-tab --title "gc2xy - HYBRID" cmd /k cd /d "%%~dp0" ^&^& "%%~dp0service-hybrid.exe" >> .dist\start-hybrid.cmd
echo exit /b 0 >> .dist\start-hybrid.cmd
echo. >> .dist\start-hybrid.cmd
echo :run_direct >> .dist\start-hybrid.cmd
echo "%%~dp0service-hybrid.exe" >> .dist\start-hybrid.cmd

:: PROXY
echo @echo off > .dist\start-proxy.cmd
echo setlocal >> .dist\start-proxy.cmd
echo. >> .dist\start-proxy.cmd
echo :: Load .env if present >> .dist\start-proxy.cmd
echo if exist "%%~dp0.config\.env" for /f "usebackq delims=" %%%%x in ("%%~dp0.config\.env") do set "%%%%x" 2^>nul >> .dist\start-proxy.cmd
echo. >> .dist\start-proxy.cmd
echo :: Windows Terminal auto-detect (unless ENFORCE_CMD=1) >> .dist\start-proxy.cmd
echo if "%%ENFORCE_CMD%%"=="1" goto :run_direct >> .dist\start-proxy.cmd
echo where wt.exe ^>nul 2^>^&1 >> .dist\start-proxy.cmd
echo if errorlevel 1 goto :run_direct >> .dist\start-proxy.cmd
echo if not "%%WT_SESSION%%"=="" goto :run_direct >> .dist\start-proxy.cmd
echo. >> .dist\start-proxy.cmd
echo :: Relaunch in Windows Terminal >> .dist\start-proxy.cmd
echo wt.exe new-tab --title "gc2xy - PROXY" cmd /k cd /d "%%~dp0" ^&^& "%%~dp0service-proxy.exe" >> .dist\start-proxy.cmd
echo exit /b 0 >> .dist\start-proxy.cmd
echo. >> .dist\start-proxy.cmd
echo :run_direct >> .dist\start-proxy.cmd
echo "%%~dp0service-proxy.exe" >> .dist\start-proxy.cmd

:: -- Step 4: Compile C# service wrapper --
echo [4/5] Compiling service.exe (C# service/console launcher)...
echo.

powershell -NoProfile -Command "$txt=Get-Content '%~f0' -Raw; $s=$txt.LastIndexOf('===CS_START===')+14; $e=$txt.LastIndexOf('===CS_END==='); $cs=$txt.Substring($s,$e-$s).Trim(); try{Add-Type -TypeDefinition $cs -OutputAssembly '.dist\service.exe' -OutputType ConsoleApplication -ReferencedAssemblies 'System.Core.dll','System.ServiceProcess.dll' -ErrorAction Stop; Write-Host '[INFO] compiled (PowerShell Add-Type)'}catch{Write-Host $_.Exception.Message; exit 1}"
if !ERRORLEVEL! equ 0 goto :cleanup_compile

:: Fallback: dotnet publish
if not exist .buildtmp mkdir .buildtmp
powershell -NoProfile -Command "$txt=Get-Content '%~f0' -Raw; $s=$txt.LastIndexOf('===CS_START===')+14; $e=$txt.LastIndexOf('===CS_END==='); $cs=$txt.Substring($s,$e-$s).Trim(); $csproj='<Project Sdk=''Microsoft.NET.Sdk''><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework><ImplicitUsings>disable</ImplicitUsings><Nullable>disable</Nullable><AssemblyName>service</AssemblyName></PropertyGroup><ItemGroup><PackageReference Include=''System.ServiceProcess.ServiceController'' Version=''9.0.0'' /></ItemGroup></Project>'; [IO.File]::WriteAllText('.buildtmp\service.csproj',$csproj); [IO.File]::WriteAllText('.buildtmp\service.cs',$cs)"

dotnet --version >nul 2>&1
if !ERRORLEVEL! equ 0 (
    dotnet publish .buildtmp\service.csproj -c Release -r win-x64 --self-contained false -p:DebugType=none -o .dist
    if !ERRORLEVEL! equ 0 ( del /q .dist\service.pdb 2>nul 2>&1 )
    for %%F in (".dist\service.exe") do if %%~zF gtr 102400 (
        echo [INFO]   ^> service.exe compiled ^(dotnet publish^)
        goto :cleanup_compile
    )
    echo [WARN]   ^> dotnet publish produced no valid exe, falling back...
    del /q .dist\service.exe 2>nul
)

:: Last resort: .NET Framework csc.exe
for %%v in ("%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319" "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319") do (
    if exist "%%~v\csc.exe" (
        "%%~v\csc.exe" /nologo /target:exe /platform:x64 /out:.dist\service.exe .buildtmp\service.cs >nul 2>&1
        if !ERRORLEVEL! equ 0 ( echo [INFO]   ^> service.exe compiled ^(csc.exe^) ) else ( echo [WARN]   ^> csc.exe failed )
        goto :cleanup_compile
    )
)
echo [WARN]   ^> no C# compiler available
if not exist .dist\service.exe ( copy /y "%~f0" .dist\service.exe >nul 2>&1 )

:cleanup_compile
if exist .buildtmp rmdir /s /q .buildtmp

:: -- Step 5: Create mode-specific service copies --
echo [5/5] Creating mode-specific service launchers...
if exist .dist\service.exe (
    copy /y .dist\service.exe .dist\service-mock.exe >nul
    copy /y .dist\service.exe .dist\service-hybrid.exe >nul
    copy /y .dist\service.exe .dist\service-proxy.exe >nul
    del /f /q .dist\service.exe >nul
)

echo.
echo ================================================
echo  Build successful ^(Bun standalone^)
echo ================================================
echo.
    echo   Output: .dist\
    echo     gc2xy                   Bun standalone server
    echo     .config\                Configuration files
    echo     gc2xy-tray.exe          Tray watcher ^(minimize to tray^)
    echo     service-mock.exe        Launcher ^(MOCK mode^)
    echo     service-hybrid.exe      Launcher ^(HYBRID mode^)
    echo     service-proxy.exe Launcher ^(PROXY mode^)
    echo     start-mock.cmd          One-shot MOCK launcher
    echo     start-hybrid.cmd        One-shot HYBRID launcher
    echo     start-proxy.cmd         One-shot PROXY launcher

echo.
echo   Run: .dist\start-mock.cmd   OR   .dist\service-mock.exe
echo.
echo   ^>^>^> Windows Service ^<^<^<
echo.
echo     sc create gc2xy-mock binPath= "\"%%CD%%\.dist\service-mock.exe\"" start= auto
echo     sc create gc2xy-hybrid binPath= "\"%%CD%%\.dist\service-hybrid.exe\"" start= auto
echo     sc create gc2xy-proxy binPath= "\"%%CD%%\.dist\service-proxy.exe\"" start= auto
echo.
echo   Notes:
echo     - gc2xy binary must be in same directory as service-*.exe
echo     - Run as Administrator for service registration
echo ================================================

del /q bun.lock 2>nul
del /q bun.lockb 2>nul
if exist .dist\.proxy-logs rmdir /s /q .dist\.proxy-logs >nul 2>&1
endlocal

:: -- Open .dist folder in Explorer --
if exist "%~dp0open-dist.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-dist.ps1" -Path "%~dp0.dist"
) else (
    start "" "%~dp0.dist"
)

exit /b 0

:: -- Embedded C# service wrapper --

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

        string baseDir = AppDomain.CurrentDomain.BaseDirectory;

        // Auto-detect Windows Terminal: relaunch in WT unless ENFORCE_CMD=1 or already in WT
        if (TryLaunchInWT())
            return 0;

        // When launched standalone, optionally host in a tray watcher that hides
        // the console window on minimize. Skipped when running as a Windows Service.
        if (TryLaunchInTray(baseDir))
            return 0;

        return RunServerLoop(interactive: true);
    }

    public static string GetAppId()
    {
        string name = Environment.GetEnvironmentVariable("gc2xy_SERVICE_NAME");
        if (!string.IsNullOrEmpty(name)) return name;
        try
        {
            // MainModule.FileName returns the actual host EXE path
            // (Assembly.Location returns the DLL path in .NET Core)
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

            if (exitCode == 45) { mode = "proxy"; SafeSetTitle("gc2xy - PROXY"); continue; }
            if (exitCode == 44) { mode = "hybrid"; SafeSetTitle("gc2xy - HYBRID"); continue; }
            if (exitCode == 43) { mode = "mock"; SafeSetTitle("gc2xy - MOCK"); continue; }
            if (exitCode == 42) continue;

            if (exitCode == 0 || exitCode == -1) return exitCode;
            return exitCode;
        }
        return 0;
    }

    static int TryLaunchServer(string baseDir, bool interactive)
    {
        string modeFlag = mode == "proxy" ? " --mode-3" : mode == "hybrid" ? " --mode-2" : "";
        // 1. Bun standalone (gc2xy binary next to service.exe)
        string gc2xyPath = Path.Combine(baseDir, "gc2xy");
        if (File.Exists(gc2xyPath))
        {
            if (interactive) Log("[INFO] Runtime: Bun (standalone)");
            if (interactive) Log("");
            return RunProcessTracked(gc2xyPath, modeFlag.TrimStart(), baseDir);
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
            string args = "\"" + tsxCli + "\" \"" + srcPath + "\"" + modeFlag;
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
                return RunProcessTracked(bunPath, "run src/mitm-proxy.ts" + modeFlag, baseDir);
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

        psi.EnvironmentVariables["gc2xy_MODE"] = mode;
        if (mode == "proxy")
        {
            psi.EnvironmentVariables["HYBRID_MODE"] = "";
            psi.EnvironmentVariables["FAKE_DEVICE_LOGIN"] = "";
            psi.EnvironmentVariables["SKIP_CACHE"] = "";
        }
        else if (mode == "hybrid")
        {
            psi.EnvironmentVariables["HYBRID_MODE"] = "1";
            psi.EnvironmentVariables["FAKE_DEVICE_LOGIN"] = "1";
            psi.EnvironmentVariables["SKIP_CACHE"] = "1";
        }
        else // mock
        {
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

    static bool TryLaunchInTray(string baseDir)
    {
        // Only for standalone interactive launches. Skip in Windows Terminal,
        // if console mode is forced, or if tray watcher is not bundled.
        if (Environment.GetEnvironmentVariable("ENFORCE_CMD") == "1")
            return false;
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WT_SESSION")))
            return false;

        string trayPath = Path.Combine(baseDir, "gc2xy-tray.exe");
        if (!File.Exists(trayPath))
            return false;

        try
        {
            string exePath = Process.GetCurrentProcess().MainModule.FileName;
            if (Environment.GetEnvironmentVariable("gc2xy_TRAY_DONE") == "1")
                return false;

            var psi = new ProcessStartInfo
            {
                FileName = trayPath,
                Arguments = "\"" + exePath + "\"",
                WorkingDirectory = baseDir,
                UseShellExecute = false,
            };
            psi.EnvironmentVariables["TRAY_WATCH_TITLE"] = "gc2xy - " + mode.ToUpper();
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

            if (string.IsNullOrWhiteSpace(output)) return;

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
