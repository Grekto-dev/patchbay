@echo off
rem  Patchbay in one click: control panel, proxy and dashboard.
rem
rem  The panel is what starts the proxy - not this script - so the proxy runs as
rem  a child of the panel and its output lands in the Live logs tab instead of a
rem  console nobody reads. Everything here is idempotent: run it with the panel
rem  and the proxy already up and it just opens the dashboard.
setlocal
set "ROOT=%~dp0"
set "PANEL=http://127.0.0.1:8878"
set "PROXY=https://127.0.0.1:8877"

rem --- control panel ---
curl -s -o nul -m 2 "%PANEL%/api/state"
if errorlevel 1 (
  echo  Starting the control panel...
  start "Patchbay - control panel" /min "%ROOT%panel.bat"
) else (
  echo  Control panel already up.
)

for /l %%i in (1,1,20) do (
  curl -s -o nul -m 2 "%PANEL%/api/state" && goto :panel_up
  timeout /t 1 /nobreak >nul
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
curl -s -m 20 -X POST -H "x-panel: 1" "%PANEL%/api/proxy/start" >nul 2>&1

for /l %%i in (1,1,15) do (
  curl -sk -o nul -m 2 "%PROXY%/" && goto :proxy_up
  timeout /t 1 /nobreak >nul
)
echo.
echo  The proxy is not answering on %PROXY%.
echo  Opening the dashboard anyway - the Live logs tab says why.
echo.

:proxy_up
rem --- dashboard ---
start "" "%PANEL%"
exit /b 0
