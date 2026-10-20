@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本，然后重新启动。
  pause
  exit /b 1
)
node "%~dp0server.mjs"
if errorlevel 1 pause
