@echo off
REM Stops the keep-alive loop AND the running server so it does NOT auto-restart.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'start-fuel-board.bat' -or $_.CommandLine -match 'fuel-board.\\server.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Fuel board stopped. It will start again on next login (or run start-fuel-board.bat).
