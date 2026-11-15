// 窗口还原：把指定 pid 的窗口从最小化恢复并置前（只动这一个窗口，不碰别的）。
// 说明：PowerShell 由本脚本内部调用，避免把 user32 调用写进命令行。
"use strict";

var cp = require("child_process");

function focus(pid) {
  var id = Number(pid) || 0;
  if (!id) return { ok: false, message: "invalid pid" };
  var ps = [
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class MbWin {",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c);",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);",
    "}",
    "'@",
    "$p = Get-Process -Id " + id + " -ErrorAction SilentlyContinue;",
    "if (-not $p) { Write-Output 'no-process'; exit 1 }",
    "$h = $p.MainWindowHandle;",
    "if ($h -eq 0) { Write-Output 'no-handle'; exit 2 }",
    "$min = [MbWin]::IsIconic($h);",
    "[MbWin]::ShowWindow($h, 9) | Out-Null;",
    "Start-Sleep -Milliseconds 200;",
    "[MbWin]::SetForegroundWindow($h) | Out-Null;",
    "Write-Output ('handle=' + $h + ' minimized=' + $min)"
  ].join("\n");
  try {
    var out = cp.execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "pipe", timeout: 20000 });
    return { ok: true, message: String(out).trim() };
  } catch (e) {
    var msg = "";
    try { msg = String(e.stdout || "") + String(e.stderr || ""); } catch (e2) { msg = e.message || ""; }
    return { ok: false, message: msg.trim().slice(0, 200) || (e.message || "") };
  }
}

module.exports = { focus: focus };

if (require.main === module) {
  var r = focus(process.argv[2]);
  console.log(JSON.stringify(r));
}
