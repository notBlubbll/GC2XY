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
if not "%ENFORCE_NODE%"=="" echo set ENFORCE_NODE=%ENFORCE_NODE%>>"%TEMP%\gc2xy_env.cmd"
powershell -NoProfile -Command "Start-Process cmd.exe -Verb RunAs -ArgumentList '/c \"%~f0\" %*'"
exit /b 0

:elevate_wt
if not "%ENFORCE_CMD%"=="" echo set ENFORCE_CMD=%ENFORCE_CMD%>"%TEMP%\gc2xy_env.cmd"
if not "%ENFORCE_NODE%"=="" echo set ENFORCE_NODE=%ENFORCE_NODE%>>"%TEMP%\gc2xy_env.cmd"
powershell -NoProfile -Command "Start-Process wt.exe -Verb RunAs -ArgumentList 'cmd /c \"%~f0\" %*'"
exit /b 0

:after_elevate
if exist "%TEMP%\gc2xy_env.cmd" call "%TEMP%\gc2xy_env.cmd" & del "%TEMP%\gc2xy_env.cmd"
if "%ENFORCE_CMD%"=="1" if not "%WT_SESSION%"=="" (
  start "" cmd.exe /c "%~f0" %*
  exit
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
:wait_ports
netstat -ano | findstr ":80 " | findstr "LISTENING" >nul 2>&1
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
set "gc2xy_SETUP_DONE=1"

:skip_setup
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
if errorlevel 42 set "INIT_MODE=mock" && goto :mock
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
if errorlevel 42 set "INIT_MODE=hybrid" && goto :hybrid
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
if errorlevel 42 set "INIT_MODE=proxy" && goto :proxy
goto :done

:force_runtime
if exist ".config\.env" for /f "usebackq delims=" %%x in (".config\.env") do (
  if "%%x"=="ENFORCE_NODE=1" (
    where node >nul 2>&1 && (set "RUNTIME=node" & set "NODE_RUNNER=node node_modules\tsx\dist\cli.cjs")
    goto :force_runtime_end
  )
)
:force_runtime_end
exit /b 0

:done
set gc2xy_SETUP_DONE=
if exist ".proxy-host-pid" del .proxy-host-pid >nul 2>&1
timeout /t 2 /nobreak >nul
exit /b 0
