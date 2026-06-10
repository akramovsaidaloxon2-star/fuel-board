@echo off
cd /d "C:\Users\fedya\fuel-board"
:loop
echo [%date% %time%] starting fuel board server >> "C:\Users\fedya\fuel-board\server.log"
"C:\Program Files\nodejs\node.exe" server.js >> "C:\Users\fedya\fuel-board\server.log" 2>&1
echo [%date% %time%] server exited, restarting in 3s... >> "C:\Users\fedya\fuel-board\server.log"
timeout /t 3 /nobreak >nul
goto loop
