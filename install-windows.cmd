@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE="
for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do (
  if not defined NODE_EXE if exist "%%~fD\bin\node.exe" set "NODE_EXE=%%~fD\bin\node.exe"
)
if not defined NODE_EXE for %%N in (node.exe) do set "NODE_EXE=%%~$PATH:N"

if not defined NODE_EXE (
  echo Node.js was not found. Install Node.js 20 or newer from https://nodejs.org/ and run this file again.
  set "RESULT=2"
  goto finish
)

"%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  set "RESULT=2"
  goto finish
)

echo Using "%NODE_EXE%"
if /i "%~1"=="--restore" goto restore
if not "%~1"=="" (
  echo Usage: install-windows.cmd [--restore]
  set "RESULT=2"
  goto finish
)

echo Applying browser fix...
"%NODE_EXE%" "%~dp0codex-browser-mac-fix.mjs"
if errorlevel 1 (
  set "RESULT=1"
  goto finish
)
echo Checking patched files...
"%NODE_EXE%" "%~dp0codex-browser-mac-fix.mjs" --check
if errorlevel 1 (
  set "RESULT=1"
  goto finish
)
echo.
echo Success. Completely close and reopen Codex, then test Chrome or Edge.
set "RESULT=0"
goto finish

:restore
echo Restoring original browser service files...
"%NODE_EXE%" "%~dp0codex-browser-mac-fix.mjs" --restore
if errorlevel 1 (
  set "RESULT=1"
  goto finish
)
echo.
echo Restored. Completely close and reopen Codex.
set "RESULT=0"

:finish
if not "%RESULT%"=="0" echo The operation did not complete. Review the statuses above before restarting Codex.
if not defined CODEX_FIX_NO_PAUSE pause
exit /b %RESULT%
