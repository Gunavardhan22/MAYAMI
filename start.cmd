@echo off
rem Double-click to start MAYAMI. Pass -Docker to use docker compose for the backend.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
