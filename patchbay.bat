@echo off
rem  Patchbay in one click: control panel, proxy and dashboard.
rem
rem  The panel is what starts the proxy - not this script - so the proxy runs as
rem  a child of the panel and its output lands in the Live logs tab instead of a
rem  console nobody reads. Everything here is idempotent: run it with the panel
rem  and the proxy already up and it just opens the dashboard.
rem
rem  Pass "nobrowser" to skip the last step - a launcher that also starts
rem  something else may not want a browser window stealing the foreground.
setlocal
set "ROOT=%~dp0"
set "PANEL=http://127.0.0.1:8878"
set "PROXY=https://127.0.0.1:8877"
rem  Full paths on purpose: both names are easy to shadow with something
rem  else on PATH (a Git Bash shell brings its own timeout, for one).
set "CURL=%SystemRoot%\System32\curl.exe"
rem  ping, not timeout: timeout.exe refuses to run with stdin redirected.
set "SLEEP=%SystemRoot%\System32\ping.exe -n 2 127.0.0.1"

rem --- control panel ---
"%CURL%" -s -o nul -m 2 "%PANEL%/api/state"
if errorlevel 1 (
  echo  Starting the control panel...
  start "Patchbay - control panel" /min "%ROOT%panel.bat"
) else (
  echo  Control panel already up.
)

for /l %%i in (1,1,15) do (
  "%CURL%" -s -o nul -m 2 "%PANEL%/api/state" && goto :panel_up
  %SLEEP% >nul
)
echo.
echo  The panel never answered on %PANEL%.
echo  Start it by hand with panel.bat and read its window.
echo.
pause
exit /b 1

:panel_up
rem --- proxy ---
rem  Already running (started elsewhere, or by an earlier click)? The panel
rem  answers with an error and nothing is started twice.
echo  Making sure the proxy is up...
"%CURL%" -s -m 20 -X POST -H "x-panel: 1" "%PANEL%/api/proxy/start" >nul 2>&1

for /l %%i in (1,1,12) do (
  "%CURL%" -sk -o nul -m 2 "%PROXY%/" && goto :proxy_up
  %SLEEP% >nul
)
echo.
echo  The proxy is not answering on %PROXY%.
echo  Opening the dashboard anyway - the Live logs tab says why.
echo.

:proxy_up
rem --- dashboard ---
if /i "%~1"=="nobrowser" (
  echo  Dashboard: %PANEL%
) else (
  start "" "%PANEL%"
)
exit /b 0
