@echo off
title Put the Attendance App online
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\deploy-vercel.ps1"
echo.
pause
