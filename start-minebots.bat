@echo off
chcp 65001 >nul
setlocal
title MineBots 启动器 / Launcher
cd /d "%~dp0"

echo ============================================
echo   MineBots 启动中 / Starting MineBots
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误 / ERROR] 没找到 Node.js，请先装 Node.js 18+ / Node.js 18+ not found, install from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [提示 / INFO] 首次运行，正在安装依赖 / first run, installing dependencies ...
  call npm install
  if errorlevel 1 (
    echo [错误 / ERROR] 依赖安装失败 / npm install failed
    pause
    exit /b 1
  )
)

if not exist "gui\main.js" (
  echo [错误 / ERROR] 缺少 gui\main.js / missing gui\main.js
  pause
  exit /b 1
)

echo [提示 / INFO] 正在打开界面 / opening GUI ...
call npx electron "gui\main.js"
if errorlevel 1 (
  echo [提示 / INFO] npx 启动失败，改用 npm start 重试 / retry with npm start
  call npm start
  if errorlevel 1 (
    echo [错误 / ERROR] 启动失败，请检查上方报错 / launch failed, see errors above
    pause
    exit /b 1
  )
)

echo [提示 / INFO] MineBots 已退出 / MineBots closed
endlocal
exit /b 0