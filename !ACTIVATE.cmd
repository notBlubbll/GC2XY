@echo off
title gc2xy
cd /d "%~dp0"

if not exist ".config" mkdir ".config"
if exist ".config\.env" for /f "usebackq delims=" %%x in (".config\.env") do set "%%x" 2>nul

net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    start "" powershell -NoP -Command "Start-Process cmd -Verb RunAs -ArgumentList '/c \"\"%~f0\" %*\"'"
    exit /b
)
if "%gc2xy_SETUP_DONE%"=="1" goto :skip_setup

set "INIT_MODE=%~1"
if "%INIT_MODE%"=="" set "INIT_MODE=mock"
if /i "%INIT_MODE%"=="1" set "INIT_MODE=mock"
if /i "%INIT_MODE%"=="2" set "INIT_MODE=hybrid"
if /i "%INIT_MODE%"=="3" set "INIT_MODE=proxy"

echo ==================================================
echo  gc2xy - Activate MITM Proxy
echo ==================================================

echo [1/4] Cleaning up...
if not exist ".cache\proxy-host-pid" goto :skip_pid_kill
for /f %%p in (.cache\proxy-host-pid) do (
    taskkill /F /PID %%p >nul 2>&1
    timeout /t 1 /nobreak >nul
)
del .cache\proxy-host-pid >nul 2>&1
:skip_pid_kill

sc query w3svc | findstr "RUNNING" >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :no_iis
echo   IIS detected - using IIS reverse proxy mode on port 3080
set IIS_PROXY=1
set gc2xy_HTTP_PORT=3080

echo   Cleaning up stale SSL bindings (gc2xy appid only)...
rem Remove leftover global ipport binding from old runs (poisons other IIS sites)
netsh http delete sslcert ipport=0.0.0.0:443 >nul 2>&1
netsh http delete sslcert ipport=[::]:443 >nul 2>&1
rem Remove SNI bindings for our hostnames
for %%h in (github.com www.github.com api.github.com api.githubcopilot.com copilot-proxy.githubusercontent.com api.individual.githubcopilot.com origin-tracker.individual.githubcopilot.com proxy.individual.githubcopilot.com telemetry.individual.githubcopilot.com) do (
    netsh http delete sslcert "hostnameport=%%h:443" >nul 2>&1
)

:iis_site_setup
echo   Setting up IIS site...
set "IIS_DIR=%~dp0.iis-site"
set "SITE_NAME=gc2xy"
set "APP_CMD=%SystemRoot%\System32\inetsrv\appcmd"
rem Ensure app pool exists (may be missing if site was created by another project)
%APP_CMD% list apppool "%SITE_NAME%" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    %APP_CMD% add apppool /name:"%SITE_NAME%" /managedRuntimeVersion:"" >nul 2>&1
    echo   App pool created.
)
rem Create site if missing
%APP_CMD% list site "%SITE_NAME%" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    %APP_CMD% add site /name:"%SITE_NAME%" /physicalPath:"%IIS_DIR%" /applicationPool:"%SITE_NAME%" /serverAutoStart:true >nul 2>&1
    echo   IIS site created.
) else (
    echo   IIS site already exists - updating config...
)
rem Always update physical path, app pool, and bindings (stale config from other projects)
%APP_CMD% set vdir "%SITE_NAME%/" -physicalPath:"%IIS_DIR%" >nul 2>&1
%APP_CMD% set app "%SITE_NAME%/" -applicationPool:"%SITE_NAME%" >nul 2>&1
%APP_CMD% set site "%SITE_NAME%" "/-bindings" >nul 2>&1
for %%h in (github.com www.github.com api.github.com api.githubcopilot.com copilot-proxy.githubusercontent.com api.individual.githubcopilot.com origin-tracker.individual.githubcopilot.com proxy.individual.githubcopilot.com telemetry.individual.githubcopilot.com) do (
    %APP_CMD% set site "%SITE_NAME%" "/+bindings.[protocol='http',bindingInformation='*:80:%%h']" >nul 2>&1
    %APP_CMD% set site "%SITE_NAME%" "/+bindings.[protocol='https',bindingInformation='*:443:%%h',sslFlags='1']" >nul 2>&1
)
rem Ensure .iis-site folder and web.config exist
if not exist "%IIS_DIR%" mkdir "%IIS_DIR%"
if not exist "%IIS_DIR%\web.config" (
    echo ^<?xml version="1.0" encoding="UTF-8"?^>^<configuration^>^<system.webServer^>^<rewrite^>^<rules^>^<rule name="ReverseProxyTo_gc2xy" stopProcessing="true"^>^<match url="(.*)" /^>^<action type="Rewrite" url="http://127.0.0.1:3080/{R:1}" /^>^</rule^>^</rules^>^</rewrite^>^</system.webServer^>^</configuration^> > "%IIS_DIR%\web.config"
    echo   web.config written with reverse proxy rule.
)

echo   Assigning SSL certificate...
call :iis_ssl_bind

echo   Enabling reverse proxy...
%APP_CMD% set config -section:system.webServer/proxy /enabled:"True" /reverseRewriteHostInResponseHeaders:"False" /preserveHostHeader:"True" >nul 2>&1
iisreset
timeout /t 3 /nobreak >nul
rem Start app pool and site AFTER iisreset with retry (WAS may not be ready immediately)
set IIS_RETRY=0
:iis_start_retry
%APP_CMD% start apppool "%SITE_NAME%" >nul 2>&1
%APP_CMD% start site "%SITE_NAME%" >nul 2>&1
timeout /t 1 /nobreak >nul
%APP_CMD% list site "%SITE_NAME%" | findstr "state:Started" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :iis_started
set /a IIS_RETRY+=1
if %IIS_RETRY% lss 5 goto :iis_start_retry
echo   WARNING: IIS site did not reach Started state after 5 retries.
goto :iis_done
:iis_started
echo   IIS site started successfully.
:iis_done

goto :detect_runtime

:no_iis
set WAIT=0
:wait_ports
netstat -ano | findstr "127.0.0.1:80 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :ports_free
timeout /t 1 /nobreak >nul
set /a WAIT+=1
if %WAIT% lss 10 goto :wait_ports
:ports_free

:detect_runtime
set RUNTIME_FOUND=
set "NODE_RUNNER="
if "%ENFORCE_NODE%"=="1" goto :try_node
if not exist "%USERPROFILE%\.bun\bin\bun.exe" goto :try_node
set "RUNTIME=bun"
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
set RUNTIME_FOUND=1
goto :check_runtime

:try_node
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :check_runtime
if exist "node_modules" goto :npm_skip
echo [INFO] Installing Node.js dependencies...
npm install --no-audit --no-fund
if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)
:npm_skip
set "RUNTIME=node"
set "NODE_RUNNER=node node_modules\tsx\dist\cli.cjs"
set RUNTIME_FOUND=1

:check_runtime
if defined RUNTIME_FOUND goto :runtime_ok
echo ERROR: Neither bun.exe nor node.exe found.
echo Install Bun ^(https://bun.sh^) or Node.js ^(https://nodejs.org^)
pause
exit /b 1

:runtime_ok
echo [INFO] Runtime: %RUNTIME%

echo [2/4] Installing CA certificate...
ipconfig /flushdns >nul 2>&1
if not exist ".certs\ca-cert.pem" goto :no_cert
certutil -store ROOT | findstr /i "MITM Debug Proxy" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   CA certificate already installed.
    goto :cert_done
)
certutil -delstore ROOT "MITM Debug Proxy" >nul 2>&1
certutil -addstore ROOT ".certs\ca-cert.pem" >nul
echo   CA certificate installed.
goto :cert_done

:no_cert
echo   No CA certificate found - will be generated on first run.

:cert_done
echo.
echo [2.5/4] Ensuring hosts file redirect...
findstr /C:"127.0.0.1 github.com" "C:\Windows\System32\drivers\etc\hosts" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   Hosts file already patched.
) else (
    echo 127.0.0.1 github.com www.github.com api.github.com api.githubcopilot.com copilot-proxy.githubusercontent.com api.individual.githubcopilot.com origin-tracker.individual.githubcopilot.com proxy.individual.githubcopilot.com telemetry.individual.githubcopilot.com >> "C:\Windows\System32\drivers\etc\hosts"
    echo   Hosts file patched.
)
ipconfig /flushdns >nul 2>&1
rem Disable Chrome DNS-over-HTTPS (bypasses hosts file)
reg add "HKLM\SOFTWARE\Policies\Google\Chrome" /v DnsOverHttpsMode /t REG_SZ /d "off" /f >nul 2>&1
reg add "HKLM\SOFTWARE\Policies\Google\Chrome" /v DnsOverHttpsTemplates /t REG_SZ /d "" /f >nul 2>&1
echo   Chrome DoH disabled. YOU MUST close and reopen Chrome for this to take effect.
echo.
set "gc2xy_SETUP_DONE=1"

:skip_setup
if "%gc2xy_RESTART%"=="1" call :read_config_mode && set "gc2xy_RESTART=" && if exist ".config\.env" for /f "usebackq delims=" %%x in (".config\.env") do set "%%x" 2>nul
if "%INIT_MODE%"=="" set "INIT_MODE=mock"
if /i "%INIT_MODE%"=="hybrid" goto :hybrid
if /i "%INIT_MODE%"=="proxy" goto :proxy

:mock
call :force_runtime
set FAKE_DEVICE_LOGIN=1
set SKIP_CACHE=1
set INTERCEPT_MODE=hosts
set gc2xy_MODE=mock
title gc2xy
if "%RUNTIME%"=="bun" bun run src\mitm-proxy.ts
if "%RUNTIME%"=="node" %NODE_RUNNER% src\mitm-proxy.ts
if errorlevel 45 set "INIT_MODE=proxy" && goto :proxy
if errorlevel 44 set "INIT_MODE=hybrid" && goto :hybrid
if errorlevel 43 set "INIT_MODE=mock" && goto :mock
if errorlevel 42 set "gc2xy_RESTART=1" && goto :skip_setup
goto :done

:hybrid
call :force_runtime
set FAKE_DEVICE_LOGIN=1
set SKIP_CACHE=1
set INTERCEPT_MODE=hosts
set gc2xy_MODE=hybrid
title gc2xy
if "%RUNTIME%"=="bun" bun run src\mitm-proxy.ts --mode-2
if "%RUNTIME%"=="node" %NODE_RUNNER% src\mitm-proxy.ts --mode-2
if errorlevel 45 set "INIT_MODE=proxy" && goto :proxy
if errorlevel 44 set "INIT_MODE=hybrid" && goto :hybrid
if errorlevel 43 set "INIT_MODE=mock" && goto :mock
if errorlevel 42 set "gc2xy_RESTART=1" && goto :skip_setup
goto :done

:proxy
call :force_runtime
set FAKE_DEVICE_LOGIN=
set SKIP_CACHE=
set INTERCEPT_MODE=hosts
set gc2xy_MODE=proxy
title gc2xy
if "%RUNTIME%"=="bun" bun run src\mitm-proxy.ts --mode-3
if "%RUNTIME%"=="node" %NODE_RUNNER% src\mitm-proxy.ts --mode-3
if errorlevel 45 set "INIT_MODE=proxy" && goto :proxy
if errorlevel 44 set "INIT_MODE=hybrid" && goto :hybrid
if errorlevel 43 set "INIT_MODE=mock" && goto :mock
if errorlevel 42 set "gc2xy_RESTART=1" && goto :skip_setup
goto :done

:read_config_mode
if exist ".cache\restart-mode" (
    set /p INIT_MODE=<".cache\restart-mode"
) else if exist ".config\config.json" (
    for /f "usebackq delims=" %%m in (`powershell -NoProfile -Command "try{$c=Get-Content '.config\config.json' -Raw|ConvertFrom-Json;if($c.mode){Write-Output $c.mode}}catch{}" 2^>nul`) do set "INIT_MODE=%%m"
)
if not defined INIT_MODE set "INIT_MODE=mock"
exit /b 0

:force_runtime
if exist ".config\.env" for /f "usebackq delims=" %%x in (".config\.env") do (
  if "%%x"=="ENFORCE_NODE=1" (
    where node >nul 2>&1 && (set "RUNTIME=node" & set "NODE_RUNNER=node node_modules\tsx\dist\cli.cjs")
    goto :force_runtime_end
  )
)
:force_runtime_end
exit /b 0

:iis_ssl_bind
setlocal enabledelayedexpansion
set "CERT_HASH="
rem Remove any old CNG/KSP-backed MITM Proxy certs (PrivateKey=null = CNG key, incompatible with netsh)
powershell -NoProfile -Command "Get-ChildItem Cert:\LocalMachine\My | Where-Object {$_.Subject -eq 'CN=MITM Proxy' -and $_.PrivateKey -eq $null} | Remove-Item -Force" >nul 2>&1
rem Re-import PFX via certutil (uses legacy CSP, compatible with netsh/http.sys)
if exist ".certs\intercept.pfx" (
    certutil -f -p "" -importpfx MY ".certs\intercept.pfx" >nul 2>&1
    echo     Re-imported PFX via certutil - CSP-backed
) else if exist ".certs\intercept-cert.pfx" (
    certutil -f -p "" -importpfx MY ".certs\intercept-cert.pfx" >nul 2>&1
    echo     Re-imported PFX via certutil - CSP-backed
)
rem Read the ACTUAL thumbprint from Windows cert store after import
for /f "tokens=*" %%t in ('powershell -NoProfile -Command "Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Subject -eq 'CN=MITM Proxy' -and $_.HasPrivateKey } | Select-Object -First 1 -ExpandProperty Thumbprint" 2^>nul') do set "CERT_HASH=%%t"
if "!CERT_HASH!"=="" (
    echo     WARNING: No MITM cert found in store after import.
    exit /b 1
)
echo     Cert hash: !CERT_HASH!
rem SNI-based bindings per intercepted host only (no ipport= — that poisons other IIS sites)
for %%h in (github.com www.github.com api.github.com api.githubcopilot.com copilot-proxy.githubusercontent.com api.individual.githubcopilot.com origin-tracker.individual.githubcopilot.com proxy.individual.githubcopilot.com telemetry.individual.githubcopilot.com) do (
    netsh http delete sslcert hostnameport=%%h:443 >nul 2>&1
    netsh http add sslcert hostnameport=%%h:443 certhash=!CERT_HASH! appid={4dc3e181-e14b-4a21-b022-59fc669b0914} certstorename=MY >nul 2>&1
    if !ERRORLEVEL! equ 0 (echo     + %%h) else (echo     FAIL: %%h)
)
rem Preserve other IIS sites on port 443 by registering their certs as SNI bindings
rem The secure site has a non-SNI binding on *:443 which breaks without an http.sys entry
call :iis_preserve_other_sites
exit /b 0

:iis_preserve_other_sites
setlocal enabledelayedexpansion
rem Preserve other IIS sites on port 443 by registering their SSL certs as SNI in http.sys
rem Uses iis-preserve-sites.ps1 to extract hostnames and cert hashes from IIS config
set "PS_SCRIPT=%~dp0iis-preserve-sites.ps1"
if not exist "%PS_SCRIPT%" exit /b 0
for /f "tokens=1,2 delims=|" %%a in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" 2^>nul') do (
    set "OTH_HASH=%%a"
    set "OTH_HOST=%%b"
    netsh http add sslcert hostnameport=!OTH_HOST!:443 certhash=!OTH_HASH! appid={4dc3e181-e14b-4a21-b022-59fc669b0914} certstorename=MY >nul 2>&1
    if !ERRORLEVEL! equ 0 (echo     + !OTH_HOST! [preserved]) else (echo     SKIP: !OTH_HOST! [already bound])
)
exit /b 0

:done
set gc2xy_SETUP_DONE=
if exist ".cache\proxy-host-pid" del .cache\proxy-host-pid >nul 2>&1
timeout /t 2 /nobreak >nul
exit /b 0
