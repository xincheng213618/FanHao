@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" -Open %*
set "RUN_EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %RUN_EXIT_CODE%
