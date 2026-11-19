@echo off
rem Xianyu auto workbench - start guard (auto restart), hidden.
rem Single instance is guaranteed by guard.cjs own data\guard.pid lock.
setlocal
cd /d "%~dp0"

set "NODE_EXE="
for /f "usebackq delims=" %%I in (`where node 2^>nul`) do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE set "NODE_EXE=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" (
  echo [ERR] node.exe not found
  exit /b 1
)

echo [start] "%NODE_EXE%" scripts\guard.cjs
start "" /min "%NODE_EXE%" "%~dp0scripts\guard.cjs" --port 5175
exit /b 0
