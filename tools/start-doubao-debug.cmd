@echo off
rem 用「可抓包」的方式启动电脑版豆包：只在 127.0.0.1:9222 开一个调试口，
rem 不走代理、不改系统设置、不影响豆包正常使用。关掉这个口只要正常启动豆包即可。
setlocal
set "DOUBAO=E:\豆包\Doubao\app\Doubao.exe"
if not exist "%DOUBAO%" (
  echo 找不到 %DOUBAO%
  echo 请把本文件里的 DOUBAO 改成你机器上豆包的实际路径。
  pause
  exit /b 1
)
tasklist /FI "IMAGENAME eq Doubao.exe" | find /I "Doubao.exe" >nul
if not errorlevel 1 (
  echo 豆包已经在运行。要抓包请先完全退出豆包（右下角托盘也要退），再运行本文件。
  pause
  exit /b 1
)
start "" "%DOUBAO%" --remote-debugging-port=9222
echo 已启动（调试口 127.0.0.1:9222）。现在可以去点签到了。
timeout /t 3 >nul
