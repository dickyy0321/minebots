@echo off
chcp 65001 >nul
setlocal
title MineBots 控制台 / Console
cd /d "%~dp0"

echo ============================================
echo   MineBots 启动中 / Starting MineBots
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误 / ERROR] 这台电脑没有检测到 Node.js / Node.js was NOT found.
  echo.
  echo   请先安装 Node.js 18 或更高版本 / Please install Node.js 18 or newer:
  echo   https://nodejs.org/   -- 选 LTS 版本 / choose the LTS build
  echo   装完之后重新双击本文件 / then double-click this file again.
  echo.
  echo   窗口不会自动关闭，按任意键退出 / press any key to close.
  pause >nul
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误 / ERROR] 找到了 Node.js 但没找到 npm / npm is missing.
  echo   请重新安装 Node.js LTS / please reinstall Node.js LTS: https://nodejs.org/
  pause >nul
  exit /b 1
)

if not exist "node_modules" (
  echo [提示 / INFO] 首次运行，正在安装依赖，请稍等 / first run, installing dependencies ...
  call npm install
  if errorlevel 1 (
    echo.
    echo [错误 / ERROR] 依赖安装失败 / dependency install failed, see messages above.
    pause >nul
    exit /b 1
  )
)

echo [提示 / INFO] 正在打开界面 / opening GUI ...
call npm run mb
if errorlevel 1 (
  echo.
  echo [错误 / ERROR] MineBots 启动失败 / failed to start, details above.
  echo [提示 / INFO] 请把上方的报错文字发给开发者 / please share the error text above.
)

echo.
echo [提示 / INFO] MineBots 已退出 / MineBots closed.
echo 按任意键关闭窗口 / press any key to close.
pause >nul
endlocal
exit /b 0
