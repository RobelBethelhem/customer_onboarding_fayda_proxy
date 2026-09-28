@echo off
echo Starting Anti-Spoofing Liveness Service on port 5001...
echo.
echo This service MUST be running alongside the Node.js backend for face verification.
echo Press Ctrl+C to stop.
echo.
python "%~dp0antispoof\antispoof_service.py"
pause
