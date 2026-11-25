@echo off
rem Chay trinh cap nhat CVAT Event Hotkeys. Mac dinh: setup (cai lan dau).
rem Vi du: Setup-Updater.cmd status hoac Setup-Updater.cmd uninstall
setlocal
set "CMD=%~1"
if "%CMD%"=="" set "CMD=setup"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cvat-hotkey-updater.ps1" %CMD% %2 %3 %4 %5
echo.
pause
