@echo off
title gc2xy
cd /d "%~dp0"

if exist ".config\.env" for /f "usebackq delims=" %%x in (".config\.env") do set "%%x" 2>nul

net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :elevate
goto :menu

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

:menu
if exist "%TEMP%\gc2xy_env.cmd" call "%TEMP%\gc2xy_env.cmd" & del "%TEMP%\gc2xy_env.cmd"
if "%ENFORCE_CMD%"=="1" if not "%WT_SESSION%"=="" (
  start "" cmd.exe /c "%~f0" %*
  exit
)
echo ==================================================
echo  gc2xy - MITM Debug Proxy
echo ==================================================
echo.
echo Select mode:
echo   1 = MOCK ^(offline, fake responses^)
echo   2 = HYBRID ^(browse GitHub, mock copilot^)
echo   3 = PROXY ^(real GitHub, capture traffic^)
echo.
set /p MODE="Enter 1, 2, or 3: "

if "%MODE%"=="1" set "MODE=mock"
if "%MODE%"=="2" set "MODE=hybrid"
if "%MODE%"=="3" set "MODE=proxy"
if "%MODE%"=="" set "MODE=mock"

call "!ACTIVATE.cmd" %MODE%
