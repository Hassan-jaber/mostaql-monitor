@echo off
echo ================================================
echo   Mostaql Monitor — Setup Script
echo ================================================
echo.

echo [1/3] Installing Node.js dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

echo.
echo [2/3] Installing Playwright browser (Chromium)...
call npx playwright install chromium
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: Playwright browser install failed - trying alternative...
    call npx playwright install --with-deps chromium
)

echo.
echo [3/3] Creating .env file...
if not exist .env (
    copy .env.example .env
    echo .env file created. Please edit it and add your Telegram credentials.
) else (
    echo .env already exists, skipping.
)

echo.
echo ================================================
echo   Setup complete!
echo.
echo   Next steps:
echo   1. Edit .env file and add:
echo      TELEGRAM_BOT_TOKEN=your_bot_token
echo      TELEGRAM_CHAT_ID=your_chat_id
echo.
echo   2. Run the monitor:
echo      npm run dev
echo ================================================
pause
