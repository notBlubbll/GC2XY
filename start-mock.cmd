@echo off
title gc2xy
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
if not "%ENFORCE_NODE%"==""   echo set ENFORCE_NODE=%ENFORCE_NODE%>>"%TEMP%\gc2xy_env.cmd"
powershell -NoProfile -Command "Start-Process cmd.exe -Verb RunAs -ArgumentList '/c \"^%~f0\" %*'"
exit /b 0

:elevate_wt
if not "%ENFORCE_CMD%"=="" echo set ENFORCE_CMD=%ENFORCE_CMD%>"%TEMP%\gc2xy_env.cmd"
if not "%ENFORCE_NODE%"==""   echo set ENFORCE_NODE=%ENFORCE_NODE%>>"%TEMP%\gc2xy_env.cmd"
powershell -NoProfile -Command "Start-Process wt.exe -Verb RunAs -ArgumentList 'cmd /c \"^%~f0\" %*'"
exit /b 0

:after_elevate
if exist "%TEMP%\gc2xy_env.cmd" call "%TEMP%\gc2xy_env.cmd" & del "%TEMP%\gc2xy_env.cmd"
if "%ENFORCE_CMD%"=="1" if not "%WT_SESSION%"=="" (
  start "" cmd.exe /c "%~f0" %*
  exit
)
echo ==================================================
echo  gc2xy - Complete Offline Mock Mode
echo  ALL traffic intercepted - no real GitHub calls
echo  Cache serves any routes without fake handlers
echo ==================================================
echo.

echo [1/3] Cleaning up ports...
if not exist ".proxy-host-pid" goto :skip_pid_kill
for /f %%p in (.proxy-host-pid) do (
    taskkill /F /PID %%p >nul 2>&1
    timeout /t 1 /nobreak >nul
)
del .proxy-host-pid >nul 2>&1
:skip_pid_kill

taskkill /F /IM bun.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1

sc query w3svc | findstr "RUNNING" >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :no_iis
echo   IIS detected - using IIS reverse proxy mode on port 3080
set IIS_PROXY=1
set gc2xy_HTTP_PORT=3080
goto :detect_runtime

:no_iis
set WAIT=0
:wait_ports_mock
netstat -ano | findstr ":80 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :ports_free_mock
timeout /t 1 /nobreak >nul
set /a WAIT+=1
if %WAIT% lss 5 goto :wait_ports_mock
:ports_free_mock

if not exist ".certs\ca-cert.pem" goto :skip_cert
certutil -store ROOT | findstr /i "MITM Debug Proxy" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :skip_cert
certutil -delstore ROOT "MITM Debug Proxy" >nul 2>&1
certutil -addstore ROOT ".certs\ca-cert.pem" >nul
:skip_cert

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

echo [2/3] Starting proxy in complete mock mode...
set FAKE_DEVICE_LOGIN=1
set SKIP_CACHE=1

echo.
echo ==================================================
echo  Mock mode active. Single fake user:
echo   login: fake-copilot-user
echo   token: gho_fake_* auto-generated on each run
echo ==================================================
echo.

:restart_mock
call :force_runtime
if "%RUNTIME%"=="bun" bun run src\mitm-proxy.ts
if "%RUNTIME%"=="node" %NODE_RUNNER% src\mitm-proxy.ts
if errorlevel 45 call "!ACTIVATE.cmd" proxy & exit /b
if errorlevel 44 call "!ACTIVATE.cmd" hybrid & exit /b
if errorlevel 43 call "!ACTIVATE.cmd" mock & exit /b
if errorlevel 42 goto :restart_mock

echo.
echo Proxy stopped.
if exist ".proxy-host-pid" del .proxy-host-pid >nul 2>&1
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
