# SPDX-License-Identifier: AGPL-3.0-only
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$activationStage = 'input'
try {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  $clientExecutable = [IO.Path]::GetFullPath([string]$request.executable)
  $clientProfile = [string]$request.userDataDir
  $defaultClientProfile = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),'DoubaoWork','User Data')
  if ([IO.Path]::GetFileName($clientExecutable) -ine 'DoubaoWork.exe' -or -not [IO.File]::Exists($clientExecutable)) { exit 2 }
  $activationStage = 'compile'
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class DoubaoGatewayNativeWindow {
  private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern IntPtr GetLastActivePopup(IntPtr window);
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint first, uint second, bool attach);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] private struct FlashInfo {
    public uint size; public IntPtr window; public uint flags; public uint count; public uint timeout;
  }
  [DllImport("user32.dll")] private static extern bool FlashWindowEx(ref FlashInfo info);
  public static IntPtr Find(int process) {
    IntPtr result = IntPtr.Zero;
    EnumWindows(delegate(IntPtr window, IntPtr parameter) {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner == process && GetWindowTextLength(window) > 0 && GetWindow(window, 4) == IntPtr.Zero && (IsWindowVisible(window) || IsIconic(window))) {
        result = window; return false;
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
  public static bool Foreground(IntPtr window) {
    ShowWindowAsync(window, IsIconic(window) ? 9 : 5);
    for (int attempt = 0; attempt < 10 && IsIconic(window); attempt++) Thread.Sleep(30);
    IntPtr popup = GetLastActivePopup(window);
    if (popup != IntPtr.Zero && IsWindowVisible(popup)) window = popup;
    SetForegroundWindow(window);
    if (GetForegroundWindow() == window) return true;
    uint ignored;
    uint current = GetCurrentThreadId();
    uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
    uint target = GetWindowThreadProcessId(window, out ignored);
    bool attachedForeground = false, attachedTarget = false;
    try {
      if (foreground != 0 && foreground != current) attachedForeground = AttachThreadInput(current, foreground, true);
      if (target != 0 && target != current && target != foreground) attachedTarget = AttachThreadInput(current, target, true);
      BringWindowToTop(window);
      SetForegroundWindow(window);
    } finally {
      if (attachedTarget) AttachThreadInput(current, target, false);
      if (attachedForeground) AttachThreadInput(current, foreground, false);
    }
    if (GetForegroundWindow() == window) return true;
    FlashInfo info = new FlashInfo { size = (uint)Marshal.SizeOf(typeof(FlashInfo)), window = window, flags = 3, count = 5, timeout = 0 };
    FlashWindowEx(ref info);
    return false;
  }
}
'@
  $activationStage = 'discover'
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  function Find-ClientWindow {
    foreach ($candidate in @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'DoubaoWork.exe'")) {
      if ($candidate.SessionId -ne $session -or $candidate.ExecutablePath -ine $clientExecutable) { continue }
      # The installed client's independent login browser shares the executable.
      if ($candidate.CommandLine -match '(?i)(?:^|\s)--(?:saman-browser-entry|type)(?:\s|=|$)') { continue }
      if ($clientProfile -and ([string]$candidate.CommandLine).IndexOf($clientProfile, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        # An already-running default client normally has no --user-data-dir flag.
        if ($clientProfile -ine $defaultClientProfile -or $candidate.CommandLine -match '(?i)--user-data-dir(?:=|\s)') { continue }
      }
      $window = [DoubaoGatewayNativeWindow]::Find([int]$candidate.ProcessId)
      if ($window -ne [IntPtr]::Zero) { return $window }
    }
    return [IntPtr]::Zero
  }
  $window = Find-ClientWindow
  $launched = $false
  if ($window -eq [IntPtr]::Zero) {
    $activationStage = 'launch'
    $options = @{ FilePath = $clientExecutable; WorkingDirectory = [IO.Path]::GetDirectoryName($clientExecutable); WindowStyle = 'Normal'; PassThru = $true }
    if ($clientProfile) { $options.ArgumentList = @('--user-data-dir="' + $clientProfile + '"') }
    $null = Start-Process @options
    $launched = $true
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
      [Threading.Thread]::Sleep(200)
      $window = Find-ClientWindow
    } while ($window -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
  }
  if ($window -eq [IntPtr]::Zero) { exit 3 }
  $activationStage = 'foreground'
  $state = if ([DoubaoGatewayNativeWindow]::Foreground($window)) { 'foreground' } else { 'attention' }
  [Console]::WriteLine((@{ state = $state; launched = $launched } | ConvertTo-Json -Compress))
} catch {
  # Never echo process command lines, private helper input or native errors.
  [Console]::WriteLine((@{ state = 'error'; stage = $activationStage } | ConvertTo-Json -Compress))
  exit 1
}
