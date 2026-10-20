@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\test-network-guard.ps1" -Action Restore
if errorlevel 1 pause
