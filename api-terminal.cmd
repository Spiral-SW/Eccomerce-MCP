@echo off
cd /d "%~dp0"
call npm.cmd run api
if errorlevel 1 pause
