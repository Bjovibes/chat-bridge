@echo off
title Chat Bridge
cd /d "%~dp0"
set ELECTRON=%~dp0node_modules\electron\dist\electron.exe
if exist "%ELECTRON%" (
  "%ELECTRON%" .
) else (
  echo Electron not found, resolving via npx (first run only)...
  npx electron .
)
if errorlevel 1 (
  echo.
  echo Chat Bridge exited with an error. If this is the first run, run: npm install
  pause
)
