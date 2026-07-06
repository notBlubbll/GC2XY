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
echo ==================================================
echo  gc2xy - Hybrid Mode
echo  GitHub browsing works normally
echo  Copilot API + Auth fully mocked
echo ==================================================
echo.

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

echo   Cleaning up stale SSL bindings...
netsh http delete sslcert "ipport=[::]:443" >nul 2>&1
netsh http delete sslcert "ipport=0.0.0.0:443" >nul 2>&1

echo   Setting up IIS site...
set "IIS_DIR=%~dp0iis-site"
set "SITE_NAME=gc2xy"
appcmd list site "%SITE_NAME%" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    appcmd add site /name:"%SITE_NAME%" /physicalPath:"%IIS_DIR%" /serverAutoStart:true >nul 2>&1
    for %%h in (github.com www.github.com api.github.com api.githubcopilot.com copilot-proxy.githubusercontent.com api.individual.githubcopilot.com origin-tracker.individual.githubcopilot.com proxy.individual.githubcopilot.com telemetry.individual.githubcopilot.com dc.services.visualstudio.com) do (
        appcmd set site "%SITE_NAME%" "/+bindings.[protocol='http',bindingInformation='*:80:%%h']" >nul 2>&1
        appcmd set site "%SITE_NAME%" "/+bindings.[protocol='https',bindingInformation='*:443:%%h',sslFlags='1']" >nul 2>&1
    )
    appcmd start site "%SITE_NAME%" >nul 2>&1
    echo   IIS site created with reverse proxy bindings.
) else (
    appcmd start site "%SITE_NAME%" >nul 2>&1
    echo   IIS site already exists.
)

goto :detect_runtime

:no_iis
set WAIT=0
:wait_ports_hybrid
netstat -ano | findstr "127.0.0.1:80 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :ports_free_hybrid
timeout /t 1 /nobreak >nul
set /a WAIT+=1
if %WAIT% lss 5 goto :wait_ports_hybrid
:ports_free_hybrid

if not exist ".certs\ca-cert.pem" goto :skip_cert
certutil -store ROOT | findstr /i "MITM Debug Proxy" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :skip_cert
certutil -delstore ROOT "MITM Debug Proxy" >nul 2>&1
certutil -addstore ROOT ".certs\ca-cert.pem" >nul
:skip_cert

if "%IIS_PROXY%"=="1" goto :detect_runtime
findstr /C:"# BEGIN gc2xy PROXY" "C:\Windows\System32\drivers\etc\hosts" >nul 2>&1
if %ERRORLEVEL% equ 0 (echo   Hosts file already patched.) else (echo   Hosts file NOT patched - proxy will apply on startup.)

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

echo [2/3] Starting proxy...
echo.

set gc2xy_MODE=hybrid
set FAKE_DEVICE_LOGIN=1
set SKIP_CACHE=1
set INIT_MODE=hybrid

echo.
echo ==================================================
echo  Mode: Hybrid
echo   - GitHub browsing: passes through to real GitHub
echo   - Copilot Chat API: fully mocked
echo   - Auth ^(login/oauth^): mocked with fake user
echo ==================================================
echo.

:restart_hybrid
call :read_config_mode
call :force_runtime
if /i "%INIT_MODE%"=="proxy" set "MCLI_FLAGS=--mode proxy" && set "FAKE_DEVICE_LOGIN=" && set "SKIP_CACHE=" && set "gc2xy_MODE=proxy"
if /i "%INIT_MODE%"=="hybrid" set "MCLI_FLAGS=--mode hybrid" && set "FAKE_DEVICE_LOGIN=1" && set "SKIP_CACHE=1" && set "gc2xy_MODE=hybrid"
if /i "%INIT_MODE%"=="mock" set "MCLI_FLAGS=--mode mock" && set "FAKE_DEVICE_LOGIN=1" && set "SKIP_CACHE=1" && set "gc2xy_MODE=mock"
if "%gc2xy_RESTART%"=="1" set "MCLI_FLAGS=--restart" && set "gc2xy_RESTART="
if "%RUNTIME%"=="bun" bun run src\mitm-proxy.ts %MCLI_FLAGS%
if "%RUNTIME%"=="node" %NODE_RUNNER% src\mitm-proxy.ts %MCLI_FLAGS%
if errorlevel 42 set "gc2xy_RESTART=1" && goto :restart_hybrid

echo.
echo Proxy stopped.
if exist ".cache\proxy-host-pid" del .cache\proxy-host-pid >nul 2>&1
timeout /t 2 /nobreak >nul
exit /b 0

:read_config_mode
rem Read persisted mode from .config/config.json (authoritative source for restart)
if exist ".config\config.json" (
    for /f "usebackq delims=" %%m in (`powershell -NoProfile -Command "try{$c=Get-Content '.config\config.json' -Raw|ConvertFrom-Json;if($c.mode){Write-Output $c.mode}}catch{}" 2^>nul`) do set "INIT_MODE=%%m"
)
if not defined INIT_MODE set "INIT_MODE=hybrid"
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
