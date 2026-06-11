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
echo  gc2xy - Remove MITM Proxy
echo  Kills proxy, cleans hosts, removes CA cert
echo ==================================================
echo.

echo [1/4] Killing proxy processes...
if not exist ".cache\proxy-host-pid" goto :skip_pid_kill
for /f %%p in (.cache\proxy-host-pid) do (
    taskkill /F /PID %%p >nul 2>&1
    timeout /t 1 /nobreak >nul
)
del .cache\proxy-host-pid >nul 2>&1
:skip_pid_kill

taskkill /F /IM bun.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/4] Removing hosts file redirect entries...
set "HOSTS=C:\Windows\System32\drivers\etc\hosts"
if not exist "%HOSTS%" goto :skip_hosts
findstr /V "# MITM Debug Proxy" "%HOSTS%" > "%TEMP%\hosts-clean.tmp"
findstr /V "127.0.0.1 github" "%TEMP%\hosts-clean.tmp" > "%TEMP%\hosts-clean2.tmp"
findstr /V "127.0.0.1 api.github" "%TEMP%\hosts-clean2.tmp" > "%TEMP%\hosts-clean3.tmp"
findstr /V "127.0.0.1 copilot" "%TEMP%\hosts-clean3.tmp" > "%TEMP%\hosts-clean4.tmp"
attrib -r "%HOSTS%" >nul 2>&1
copy /Y "%TEMP%\hosts-clean4.tmp" "%HOSTS%" >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :hosts_ok
powershell -NoProfile -Command "Get-Content '%TEMP%\hosts-clean4.tmp' | Set-Content '%HOSTS%' -Force"
:hosts_ok
del "%TEMP%\hosts-clean.tmp" "%TEMP%\hosts-clean2.tmp" "%TEMP%\hosts-clean3.tmp" "%TEMP%\hosts-clean4.tmp" 2>nul
echo   Hosts file cleaned.
:skip_hosts

echo [3/4] Removing CA certificate from Windows Trusted Root Store...
certutil -delstore ROOT "MITM Debug Proxy" >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :cert_removed
echo   No CA certificate found - nothing to remove.
goto :check_iis

:cert_removed
echo   CA certificate removed.

:check_iis
echo [4/4] Releasing ports...
sc query w3svc | findstr "RUNNING" >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :iis_cleanup
echo   Releasing ports 80 and 443
powershell -NoProfile "Get-NetTCPConnection -LocalPort 80 -ErrorAction SilentlyContinue | Select -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ 2>$null }" >nul 2>&1
powershell -NoProfile "Get-NetTCPConnection -LocalPort 443 -ErrorAction SilentlyContinue | Select -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ 2>$null }" >nul 2>&1
goto :clean_done

:iis_cleanup
echo   IIS detected - cleaning SSL bindings + port 80
for %%h in (github.com www.github.com api.github.com api.githubcopilot.com copilot-proxy.githubusercontent.com api.individual.githubcopilot.com origin-tracker.individual.githubcopilot.com proxy.individual.githubcopilot.com telemetry.individual.githubcopilot.com) do (
    netsh http delete sslcert "hostnameport=%%h:443" >nul 2>&1
)
netsh http delete sslcert "ipport=0.0.0.0:443" >nul 2>&1
netsh http delete sslcert "ipport=[::]:443" >nul 2>&1
powershell -NoProfile "Get-NetTCPConnection -LocalPort 80 -ErrorAction SilentlyContinue | Select -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ 2>$null }" >nul 2>&1

:clean_done
echo.
echo ==================================================
echo  Cleanup complete. Proxy fully removed.
echo  github.com now resolves to real GitHub again.
echo ==================================================
echo.
if exist ".cache\proxy-host-pid" del .cache\proxy-host-pid >nul 2>&1
timeout /t 2 /nobreak >nul
exit /b 0
