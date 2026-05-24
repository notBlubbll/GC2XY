@echo off
setlocal enabledelayedexpansion

set PROXY_PORT=11400
set TARGET_HOST=localhost
set TARGET_PORT=11434
set LOG_DIR=.olla-logs

if not exist "%LOG_DIR%" (
    mkdir "%LOG_DIR%"
)

for /f "tokens=2 delims==" %%G in ('wmic os get localdatetime /value') do set datetime=%%G
set TIMESTAMP=%datetime:~0,4%-%datetime:~4,2%-%datetime:~6,2%_%datetime:~8,2%-%datetime:~10,2%-%datetime:~12,2%
set LOG_FILE=%LOG_DIR%\proxy-%TIMESTAMP%.log

:loop
node src\temp-proxy.cjs >> "%LOG_FILE%" 2>&1

if %ERRORLEVEL% == 42 (
    goto loop
)

endlocal