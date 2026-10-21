@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js neni nainstalovan. Stahnete jej z https://nodejs.org ^(verze 22 nebo novejsi^).
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instaluji zavislosti...
  call npm install --no-fund --no-audit || goto :error
)

echo Sestavuji aplikaci...
call npm run build --silent || goto :error

node dist\server\main.js --open
goto :eof

:error
echo Nastala chyba.
pause
exit /b 1
