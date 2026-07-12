; OmniAPI NSIS installer hooks (Tauri bundle.windows.nsis.installerHooks)
;
; Tauri 模板只处理主程序 omniapi-desktop.exe 的运行检测；核心是我们
; spawn 的 node.exe 子进程，直接从 $INSTDIR\resources\node\node.exe 运行，
; 会锁住该文件导致覆盖安装报 "Error opening file for writing"（真实踩坑）。
; 安装/卸载前先杀主程序进程树，再按可执行文件路径精确终止残留的核心
; node 进程（孤儿场景），不能用 taskkill /IM node.exe——会误杀用户自己的
; node 进程。

!macro _omniapi_kill_running
  DetailPrint "正在关闭运行中的 OmniAPI…"
  nsExec::Exec 'taskkill /F /T /IM omniapi-desktop.exe'
  nsExec::Exec `powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -eq '$INSTDIR\resources\node\node.exe' | Stop-Process -Force"`
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _omniapi_kill_running
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _omniapi_kill_running
!macroend
