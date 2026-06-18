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
