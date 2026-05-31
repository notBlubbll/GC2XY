@echo off
title gc2xy - Node.js Mode
cd /d "%~dp0"

if exist ".config\.env" for /f "usebackq delims=" %%x in (".config\.env") do set "%%x" 2>nul

net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :elevate
goto :after_elevate

:elevate
if "%ENFORCE_CMD%"=="1" goto :elevate_cmd
where wt.exe >nul 2>&1
if not errorlevel 1 goto :elevate_wt
:elevate_cmd
if not "%ENFORCE_CMD%"=="" echo set ENFORCE_CMD=%ENFORCE_CMD%>"%TEMP%\gc2xy_env.cmd"
if not "%ENFORCE_NODE%"==""    echo set ENFORCE_NODE=%ENFORCE_NODE%>>"%TEMP%\gc2xy_env.cmd"
powershell -NoProfile -Command "Start-Process cmd.exe -Verb RunAs -ArgumentList '/c \"^%~f0\" %*'"
exit /b 0

:elevate_wt
if not "%ENFORCE_CMD%"=="" echo set ENFORCE_CMD=%ENFORCE_CMD%>"%TEMP%\gc2xy_env.cmd"
if not "%ENFORCE_NODE%"==""    echo set ENFORCE_NODE=%ENFORCE_NODE%>>"%TEMP%\gc2xy_env.cmd"
powershell -NoProfile -Command "Start-Process wt.exe -Verb RunAs -ArgumentList 'cmd /c \"^%~f0\" %*'"
exit /b 0

:after_elevate
if exist "%TEMP%\gc2xy_env.cmd" call "%TEMP%\gc2xy_env.cmd" & del "%TEMP%\gc2xy_env.cmd"
if "%ENFORCE_CMD%"=="1" if not "%WT_SESSION%"=="" (
  start "" cmd.exe /c "%~f0" %*
  exit
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

taskkill /F /IM bun.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1

sc query w3svc | findstr "RUNNING" >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :no_iis
echo   IIS detected - using IIS reverse proxy mode on port 3080
set IIS_PROXY=1
set gc2xy_HTTP_PORT=3080
goto :check_cert

:no_iis
set WAIT=0
:wait_ports
netstat -ano | findstr ":80 " | findstr "LISTENING" >nul 2>&1
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

set "CUR_MODE=mock"

:restart
set FAKE_DEVICE_LOGIN=1
set SKIP_CACHE=1
set MCLI_FLAGS=

if "%CUR_MODE%"=="proxy" goto :set_proxy_mode
if "%CUR_MODE%"=="hybrid" set MCLI_FLAGS=--mode-2 && goto :run_detected
goto :run_detected

:set_proxy_mode
set FAKE_DEVICE_LOGIN=
set SKIP_CACHE=
set MCLI_FLAGS=--mode-3
goto :run_detected

:run_detected
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :try_bun

echo [2/4] Runtime: Node.js
echo [3/4] Setting up hosts redirect...
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
if %EXIT_CODE% equ 45 set "CUR_MODE=proxy" && goto :restart
if %EXIT_CODE% equ 44 set "CUR_MODE=hybrid" && goto :restart
if %EXIT_CODE% equ 43 set "CUR_MODE=mock" && goto :restart
if %EXIT_CODE% equ 42 goto :restart
goto :done

:try_bun
if "%ENFORCE_NODE%"=="1" goto :no_runtime
echo [2/4] Node.js not found, trying Bun...
where bun >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :no_runtime

echo [INFO] Runtime: Bun
echo [3/4] Setting up hosts redirect...
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
if %EXIT_CODE% equ 45 set "CUR_MODE=proxy" && goto :restart
if %EXIT_CODE% equ 44 set "CUR_MODE=hybrid" && goto :restart
if %EXIT_CODE% equ 43 set "CUR_MODE=mock" && goto :restart
if %EXIT_CODE% equ 42 goto :restart
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
