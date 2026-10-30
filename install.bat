@echo off
setlocal
title Telegram Grabber - Install / Update
set "SRC=%~dp0extension"
set "DEST=%LOCALAPPDATA%\Telegram-Grabber"

if not exist "%SRC%\manifest.json" (
  echo [ERROR] Folder "extension" not found next to this file.
  echo Please unpack the whole ZIP first.
  pause
  exit /b 1
)

echo Copying extension to:
echo   %DEST%
robocopy "%SRC%" "%DEST%" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo [ERROR] Copy failed.
  pause
  exit /b 1
)

<nul set /p="%DEST%" | clip

echo.
echo ============================================================
echo  Done. The folder path is now in your clipboard.
echo ============================================================
echo.
echo  FIRST INSTALL:
echo   1. Brave opens the extensions page.
echo   2. Turn on "Developer mode" (top right).
echo   3. Click "Load unpacked", press Ctrl+V in the path field,
echo      then click "Select folder".
echo   4. Click the puzzle icon in the toolbar and pin "Telegram Grabber".
echo.
echo  UPDATE:
echo   Just click the reload arrow on the "Telegram Grabber" card.
echo.

set "BRAVE=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE%" set "BRAVE=%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE%" set "BRAVE=%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"
if exist "%BRAVE%" (
  start "" "%BRAVE%" "brave://extensions/"
) else (
  echo Brave was not found automatically - please open brave://extensions yourself.
)
pause
