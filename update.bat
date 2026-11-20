@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cheruno.ps1" update
if errorlevel 1 pause
pause
