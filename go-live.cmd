@echo off
rem Puts the donation site online from this PC: starts the server, plus an ngrok tunnel so viewers can reach it.
rem The site is online while this window is open. Close it, and the "ngrok" window, to go offline.
cd /d "%~dp0"
set "NGROK=%LOCALAPPDATA%\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe"
if not exist "%NGROK%" set "NGROK=ngrok"
start "ngrok" /min "%NGROK%" http 3000
call npm start
