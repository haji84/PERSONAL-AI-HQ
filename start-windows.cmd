@echo off
cd /d "%~dp0"
node app\windows-launch.mjs
if errorlevel 1 pause
