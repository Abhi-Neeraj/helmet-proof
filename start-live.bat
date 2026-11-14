@echo off
rem Puts Helmet Proof on the internet from this computer.
rem
rem It opens two windows: the server, and a Cloudflare tunnel that gives the
rem server a public https address. Keep both open. Closing either one, or
rem letting the computer sleep, takes the site offline.
rem
rem The public address is different every time this is started.

cd /d "%~dp0"

if not exist "tunnel\bin\cloudflared.exe" (
  echo tunnel\bin\cloudflared.exe is missing. See "Putting the site on the internet" in README.md.
  pause
  exit /b 1
)

start "Helmet Proof server" /D "%~dp0server" cmd /k npm start

rem Give the server a moment to start before the tunnel connects to it.
timeout /t 4 /nobreak >nul

echo.
echo Starting the tunnel. In a few seconds a box appears containing a line like
echo     https://some-random-words.trycloudflare.com
echo That is your public address. Use it in the browser, the phone app and the helmet.
echo.

rem The same output is also saved to tunnel\tunnel.log, in case the box scrolls away.
if exist "tunnel\tunnel.log" del "tunnel\tunnel.log"
"tunnel\bin\cloudflared.exe" tunnel --no-autoupdate --logfile "tunnel\tunnel.log" --url http://localhost:3000
pause
