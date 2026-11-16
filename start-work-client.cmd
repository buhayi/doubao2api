@echo off
cd /d "%~dp0"
node server-client.mjs %*
if errorlevel 1 pause
