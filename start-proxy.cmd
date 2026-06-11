@echo off
title gc2xy
cd /d "%~dp0"

if exist ".config\.env" for /f "usebackq delims=" %%x in (".config\.env") do set "%%x" 2>nul

net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    start "" powershell -NoP -Command "Start-Process cmd -Verb RunAs -ArgumentList '/c \"\"%~f0\" %*\"'"
    exit /b
)
echo ==================================================
echo  gc2xy - Proxy Mode
echo  Forwards ALL traffic to real GitHub ^(no interception^)
echo  Logs everything to .proxy-logs/ for analysis
echo ==================================================
echo.

echo [1/3] Cleaning up ports...
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
    for %%h in (github.com www.github.com api.github.com api.githubcopilot.com copilot-proxy.githubusercontent.com api.individual.githubcopilot.com origin-tracker.individual.githubcopilot.com proxy.individual.githubcopilot.com telemetry.individual.githubcopilot.com) do (
        appcmd set site "%SITE_NAME%" "/+bindings.[protocol='http',bindingInformation='*:80:%%h']" >nul 2>&1
        appcmd set site "%SITE_NAME%" "/+bindings.[protocol='https',bindingInformation='*:443:%%h',sslFlags='0']" >nul 2>&1
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
:wait_ports_proxy
if %ERRORLEVEL% equ 0 goto :ports_free_proxy
netstat -ano | findstr ":80 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :ports_free_proxy
timeout /t 1 /nbreak >nul
set /a WAIT+=1
if %WAIT% lss 5 goto :wait_ports_proxy
:ports_free_proxy

if not exist ".certs\ca-cert.pem" goto :skip_cert
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

set RECORD_MODE=1

echo [3/3] All traffic logged to .proxy-logs/...
echo.
echo ==================================================
echo  Proxy running. Login to GitHub with real account now.
echo  All traffic logged and recorded for analysis.
echo  Close this window to stop.
echo ==================================================
echo.

:restart_proxy
call :force_runtime
if "%RUNTIME%"=="bun" bun run src\mitm-proxy.ts --mode-3
if "%RUNTIME%"=="node" %NODE_RUNNER% src\mitm-proxy.ts --mode-3
if errorlevel 45 call "!ACTIVATE.cmd" proxy & exit /b
if errorlevel 44 call "!ACTIVATE.cmd" hybrid & exit /b
if errorlevel 43 call "!ACTIVATE.cmd" mock & exit /b
if errorlevel 42 goto :restart_proxy

echo.
echo Proxy stopped.
if exist ".cache\proxy-host-pid" del .cache\proxy-host-pid >nul 2>&1
timeout /t 2 /nobreak >nul
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
