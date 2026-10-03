@echo off
rem Tapewire launcher for Windows: installs on first run, starts the server and opens the browser.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20 or newer is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install --omit=dev
if not exist .env copy .env.example .env >nul
start "" http://localhost:8787
node server\server.js
pause
