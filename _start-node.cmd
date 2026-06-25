@echo off
title gc2xy - Node.js Mode
cd /d "%~dp0"

if not exist ".config" mkdir ".config"
if exist ".config\.env" for /f "usebackq delims=" %%x in (".config\.env") do set "%%x" 2>nul

net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    start "" powershell -NoP -Command "Start-Process cmd -Verb RunAs -ArgumentList '/c \"\"%~f0\" %*\"'"
    exit /b
)
echo ==================================================
echo  gc2xy - Node.js Fallback Mode
echo  Runs with Node.js when Bun is unavailable
echo  All traffic intercepted - fake GitHub responses
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

goto :check_cert

:no_iis
set WAIT=0
:wait_ports
netstat -ano | findstr "127.0.0.1:80 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :ports_free
timeout /t 1 /nobreak >nul
set /a WAIT+=1
if %WAIT% lss 5 goto :wait_ports
:ports_free

:check_cert
if not exist ".certs\ca-cert.pem" goto :skip_cert
certutil -delstore ROOT "MITM Debug Proxy" >nul 2>&1
certutil -addstore ROOT ".certs\ca-cert.pem" >nul 2>&1
echo   CA certificate installed.
:skip_cert

rem Initial mode: --mode <m> param > gc2xy_MODE env > config.json > default mock
if defined gc2xy_MODE set "CUR_MODE=%gc2xy_MODE%"
if not defined CUR_MODE if exist ".config\config.json" for /f "usebackq delims=" %%m in (`powershell -NoProfile -Command "try{$c=Get-Content '.config\config.json' -Raw|ConvertFrom-Json;if($c.mode){Write-Output $c.mode}}catch{}" 2^>nul`) do set "CUR_MODE=%%m"
if not defined CUR_MODE set "CUR_MODE=mock"

:restart
set FAKE_DEVICE_LOGIN=1
set SKIP_CACHE=1
set MCLI_FLAGS=--mode %CUR_MODE%

if "%CUR_MODE%"=="proxy" goto :set_proxy_mode
if "%CUR_MODE%"=="hybrid" goto :run_detected
goto :run_detected

:restart_persisted
rem Read persisted mode from .config/config.json for restart (exit 42)
if exist ".config\config.json" for /f "usebackq delims=" %%m in (`powershell -NoProfile -Command "try{$c=Get-Content '.config\config.json' -Raw|ConvertFrom-Json;if($c.mode){Write-Output $c.mode}}catch{}" 2^>nul`) do set "CUR_MODE=%%m"
if not defined CUR_MODE set "CUR_MODE=mock"
set MCLI_FLAGS=--restart
goto :restart

:set_proxy_mode
set FAKE_DEVICE_LOGIN=
set SKIP_CACHE=
goto :run_detected

:run_detected
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :try_bun

if exist "node_modules" goto :npm_skip
if exist "package-lock.json" del /q "package-lock.json"
if exist "bun.lock" del /q "bun.lock"
echo [INFO] Installing Node.js dependencies...
npm install --no-audit --no-fund
if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)
if exist "package-lock.json" del /q "package-lock.json"
if exist "bun.lock" del /q "bun.lock"
:npm_skip
echo [2/4] Runtime: Node.js
echo [3/4] Checking hosts redirect...
if not "%IIS_PROXY%"=="1" findstr /C:"# BEGIN gc2xy PROXY" "C:\Windows\System32\drivers\etc\hosts" >nul 2>&1 && (echo   Hosts file already patched.) || (echo   Hosts file NOT patched - proxy will apply on startup.)
echo [4/4] Starting proxy...
echo.
echo ==================================================
echo  Mode: %CUR_MODE%
echo   login: fake-copilot-user
echo   token: gho_fake_* auto-generated
echo ==================================================
echo.
node node_modules\tsx\dist\cli.cjs src\mitm-proxy.ts %MCLI_FLAGS%
set EXIT_CODE=%ERRORLEVEL%
if %EXIT_CODE% equ 42 goto :restart_persisted
goto :done

:try_bun
if "%ENFORCE_NODE%"=="1" goto :no_runtime
echo [2/4] Node.js not found, trying Bun...
where bun >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :no_runtime

echo [INFO] Runtime: Bun
echo [3/4] Checking hosts redirect...
if not "%IIS_PROXY%"=="1" findstr /C:"# BEGIN gc2xy PROXY" "C:\Windows\System32\drivers\etc\hosts" >nul 2>&1 && (echo   Hosts file already patched.) || (echo   Hosts file NOT patched - proxy will apply on startup.)
echo [4/4] Starting proxy...
echo.
echo ==================================================
echo  Mode: %CUR_MODE%
echo   login: fake-copilot-user
echo   token: gho_fake_* auto-generated
echo ==================================================
echo.
bun run src\mitm-proxy.ts %MCLI_FLAGS%
set EXIT_CODE=%ERRORLEVEL%
if %EXIT_CODE% equ 42 goto :restart_persisted
goto :done

:no_runtime
echo [ERROR] Neither Node.js nor Bun found in PATH.
echo        Install Node: https://nodejs.org
echo        Install Bun:   https://bun.sh
pause

:done
echo.
echo Proxy stopped.
if exist ".cache\proxy-host-pid" del .cache\proxy-host-pid >nul 2>&1
timeout /t 2 /nobreak >nul
exit /b 0
