<#
  Show-AttnRing.ps1 — 全屏一次性提醒光圈（task-44 方案 A）
  零依赖：pwsh 7.x（或 Windows PowerShell 5.1）+ 内置 WPF/.NET，无任何外部包。
  特性：全屏置顶(WS_EX_TOPMOST|TOOLWINDOW)、不抢焦点(WS_EX_NOACTIVATE + ShowActivated=false)、
        半透明底 + 中心光圈、默认 4s 自动消失、Esc/点击可关、主屏/全部显示器、混合 DPI 正确定位。
  用法：
    pwsh -NoProfile -File Show-AttnRing.ps1 [-Seconds 4] [-Scope Primary|All] [-Anim Expand|Breathe|None]
  计划中未实现参数（传了会提示，按默认值运行）：-Color -Thickness -OverlayAlpha -RadiusPx -ReassertMs -Quiet
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 30)][int]$Seconds = 4,
    [ValidateSet('Primary', 'All')][string]$Scope = 'Primary',
    [ValidateSet('Expand', 'Breathe', 'None')][string]$Anim = 'Expand',
    # —— 以下仅占位（README 标「计划中」） ——
    [string]$Color = '',
    [int]$Thickness = 0,
    [double]$OverlayAlpha = -1,
    [int]$RadiusPx = 0,
    [int]$ReassertMs = -1,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# ---------- STA 守卫：WPF 要求 STA，MTA 下以 -STA 重开自己 ----------
if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
    $self = $PSCommandPath
    $plist = @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $self,
               '-Seconds', "$Seconds", '-Scope', $Scope, '-Anim', $Anim)
    $p = Start-Process pwsh -ArgumentList $plist -Wait -PassThru -NoNewWindow
    exit $p.ExitCode
}

$reserved = @()
if ($Color) { $reserved += '-Color' }
if ($Thickness -ne 0) { $reserved += '-Thickness' }
if ($OverlayAlpha -ge 0) { $reserved += '-OverlayAlpha' }
if ($RadiusPx -ne 0) { $reserved += '-RadiusPx' }
if ($ReassertMs -ge 0) { $reserved += '-ReassertMs' }
if ($Quiet) { $reserved += '-Quiet' }
if ($reserved.Count) { Write-Warning ("以下参数仍在「计划中」，本次按默认值运行: " + ($reserved -join ', ')) }

# ---------- 单实例（防止叠两层） ----------
$mutex = New-Object System.Threading.Mutex($false, 'Local\AttnRingOneShot')
$owned = $false
try { $owned = $mutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $owned = $true }   # 弃用锁 = 我们拿到了
catch { $owned = $false }
if (-not $owned) {
    Write-Output '{"result":"already-showing","exit":"second-instance-closed"}'
    $mutex.Dispose()
    exit 0
}

# ---------- P/Invoke：任何窗口创建前先设 DPI 感知（R3：进程级 → 线程级 → GetDpiForMonitor 兜底） ----------
if (-not ('AttnRing.Native' -as [type])) {
    $nativeSrc = @'
using System;
using System.Runtime.InteropServices;
public static class Native {
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOPMOST   = 0x00000008;
    public const int WS_EX_TOOLWINDOW= 0x00000080;
    public const int WS_EX_NOACTIVATE= 0x08000000;
    public const uint SWP_NOSIZE     = 0x0001;
    public const uint SWP_NOMOVE     = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref RECT rc, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hMonitor, int type, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    public static readonly IntPtr PM_V2 = new IntPtr(-4);   // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2

    public static string EnsureDpi() {
        try { if (SetProcessDpiAwarenessContext(PM_V2)) return "process-PM_V2"; } catch { }
        try { if (SetThreadDpiAwarenessContext(PM_V2) != IntPtr.Zero) return "thread-PM_V2"; } catch { }
        return "getdpiformonitor-fallback";
    }
    public static double DpiForRect(int x, int y, int w, int h) {
        RECT rc; rc.L = x; rc.T = y; rc.R = x + w; rc.B = y + h;
        IntPtr m = MonitorFromRect(ref rc, 2 /*MONITOR_DEFAULTTONEAREST*/);
        uint dx, dy;
        try { if (m != IntPtr.Zero && GetDpiForMonitor(m, 0 /*MDT_EFFECTIVE_DPI*/, out dx, out dy) == 0 && dx > 0) return dx; } catch { }
        return 96.0;
    }
    // 置顶 + 不进任务栏 + 不激活，并用物理像素定位
    public static void ApplyFrame(IntPtr hWnd) {
        IntPtr ex = GetWindowLongPtr(hWnd, GWL_EXSTYLE);
        IntPtr nw = new IntPtr(ex.ToInt64() | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
        SetWindowLongPtr(hWnd, GWL_EXSTYLE, nw);
        SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | 0x0040 /*SWP_SHOWWINDOW*/);
    }
    public static void Place(IntPtr hWnd, int x, int y, int w, int h) {
        SetWindowPos(hWnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE);
    }
}
'@
    Add-Type -TypeDefinition $nativeSrc
}
$dpiPath = [Native]::EnsureDpi()
$fgBefore = [Native]::GetForegroundWindow()

# ---------- WPF ----------
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

$VEIL_ALPHA = 0x3A         # 半透明底 ≈ 23% 黑（非实心遮罩；-OverlayAlpha 计划中）
$RING_COLOR  = [System.Windows.Media.Color]::FromArgb(0xFF, 0xFF, 0xA3, 0x3A)  # 琥珀（-Color 计划中）
$RING_W = 10               # 内环粗 DIP（-Thickness 计划中）
$GLOW_W = 26               # 光晕环粗 DIP

$screens = if ($Scope -eq 'All') { [System.Windows.Forms.Screen]::AllScreens } else { @([System.Windows.Forms.Screen]::PrimaryScreen) }

$script:app = New-Object System.Windows.Application
$script:app.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown

$script:screenInfo = @()
$script:windows = New-Object System.Collections.Generic.List[System.Windows.Window]
$script:manualClose = $false
$script:fading = $false
$script:closeReason = 'unknown'

function New-RingWindow($screen) {
    $b = $screen.Bounds            # 物理像素（PM_V2 下为真实坐标）
    $dpi = [Native]::DpiForRect($b.X, $b.Y, $b.Width, $b.Height)
    $scale = $dpi / 96.0

    $w = New-Object System.Windows.Window
    $w.WindowStyle = 'None'
    $w.AllowsTransparency = $true
    $w.Background = [System.Windows.Media.Brushes]::Transparent
    $w.Topmost = $true
    $w.ShowInTaskbar = $false
    $w.ShowActivated = $false      # 不抢焦点（配合 WS_EX_NOACTIVATE）
    $w.Focusable = $false
    $w.ResizeMode = 'NoResize'
    $w.WindowStartupLocation = 'Manual'
    $w.Width  = $b.Width  / $scale     # 近似 DIP 尺寸；SourceInitialized 里用物理像素校正
    $w.Height = $b.Height / $scale
    $w.Left   = $b.X / $scale
    $w.Top    = $b.Y / $scale

    $dipMin = [Math]::Min($w.Width, $w.Height)
    $ringD  = [Math]::Round($dipMin * 0.42)

    $grid = New-Object System.Windows.Controls.Grid
    $veil = New-Object System.Windows.Shapes.Rectangle
    $veil.Fill = New-Object System.Windows.Media.SolidColorBrush(
        [System.Windows.Media.Color]::FromArgb($VEIL_ALPHA, 0, 0, 0))
    [void]$grid.Children.Add($veil)

    $glow = New-Object System.Windows.Shapes.Ellipse
    $glow.Width = $ringD; $glow.Height = $ringD
    $glow.Stroke = New-Object System.Windows.Media.SolidColorBrush($RING_COLOR)
    $glow.StrokeThickness = $GLOW_W
    $glow.Opacity = 0.55
    $blur = New-Object System.Windows.Media.Effects.BlurEffect
    $blur.Radius = 20
    $glow.Effect = $blur

    $ring = New-Object System.Windows.Shapes.Ellipse
    $ring.Width = $ringD; $ring.Height = $ringD
    $ring.Stroke = New-Object System.Windows.Media.SolidColorBrush($RING_COLOR)
    $ring.StrokeThickness = $RING_W

    foreach ($el in @($glow, $ring)) {
        [void]$grid.Children.Add($el)
        $el.HorizontalAlignment = 'Center'
        $el.VerticalAlignment = 'Center'
    }

    if ($Anim -eq 'Expand') {
        $st = New-Object System.Windows.Media.ScaleTransform
        $ring.RenderTransform = $st; $ring.RenderTransformOrigin = '0.5,0.5'
        $glow.RenderTransform = $st; $glow.RenderTransformOrigin = '0.5,0.5'
        $grow = New-Object System.Windows.Media.Animation.DoubleAnimation(0.58, 1.12,
            (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(1100))))
        foreach ($p in @([System.Windows.Media.ScaleTransform]::ScaleXProperty,
                         [System.Windows.Media.ScaleTransform]::ScaleYProperty)) { $st.BeginAnimation($p, $grow) }
        $fade = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0,
            (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(650))))
        foreach ($el in @($ring, $glow)) { $el.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade) }
    }
    elseif ($Anim -eq 'Breathe') {
        $st = New-Object System.Windows.Media.ScaleTransform
        $ring.RenderTransform = $st; $ring.RenderTransformOrigin = '0.5,0.5'
        $osc = New-Object System.Windows.Media.Animation.DoubleAnimation(0.35, 1.0,
            (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(900))))
        $osc.AutoReverse = $true
        $osc.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
        $ring.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $osc)
        $breath = New-Object System.Windows.Media.Animation.DoubleAnimation(0.94, 1.06,
            (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(900))))
        $breath.AutoReverse = $true
        $breath.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
        foreach ($p in @([System.Windows.Media.ScaleTransform]::ScaleXProperty,
                         [System.Windows.Media.ScaleTransform]::ScaleYProperty)) { $st.BeginAnimation($p, $breath) }
    }
    # Anim=None：静态

    $w.Content = $grid
    # 把物理像素坐标挂到 Tag 上：事件处理器里不捕获局部变量（GetNewClosure 的闭包会让
    # WPF 事件委托里的 [type] 解析失败 / 处理器不执行 —— 实测踩过）
    $w.Tag = @{ X = $b.X; Y = $b.Y; W = $b.Width; H = $b.Height }

    # 窗口句柄创建后、显示之前：设原生样式 + 物理像素定位/尺寸
    $w.add_SourceInitialized({
        param($s, $e)
        $bb = $s.Tag
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($s)).Handle
        [Native]::ApplyFrame($hwnd)
        [Native]::Place($hwnd, [int]$bb.X, [int]$bb.Y, [int]$bb.W, [int]$bb.H)
    })

    # 点一下就关（这一击不传给下层 —— README 已知限制）
    $w.add_MouseLeftButtonDown({ $script:manualClose = $true; $script:closeReason = 'click' })
    $grid.add_MouseLeftButtonDown({ $script:manualClose = $true; $script:closeReason = 'click' })

    $script:screenInfo += [pscustomobject]@{
        device   = $screen.DeviceName
        primary  = $screen.Primary
        boundsPx = "$($b.X),$($b.Y),$($b.Width)x$($b.Height)"
        dpi      = $dpi
        scale    = $scale
        ringDip  = $ringD
    }
    return $w
}

foreach ($s in $screens) { $script:windows.Add((New-RingWindow $s)) }

function Close-All {
    if ($script:fading) { return }
    $script:fading = $true
    $fadeOut = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.0,
        (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(260))))
    $fadeOut.add_Completed({
        foreach ($w in $script:windows) { try { $w.Close() } catch { } }
        $script:app.Shutdown()
    })
    foreach ($w in $script:windows) { $w.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fadeOut) }
}

# 超时自动关
$timeout = New-Object System.Windows.Threading.DispatcherTimer
$timeout.Interval = [TimeSpan]::FromSeconds($Seconds)
$timeout.add_Tick({
    $timeout.Stop()
    if ($script:closeReason -eq 'unknown') { $script:closeReason = 'timeout' }
    Close-All
})
$timeout.Start()

# Esc 轮询（GetAsyncKeyState；不装钩子不注册热键 → 完全不拦截键盘，用户按 Esc 关全屏视频不受影响）
$escWatch = New-Object System.Windows.Threading.DispatcherTimer
$escWatch.Interval = [TimeSpan]::FromMilliseconds(40)
$escWatch.add_Tick({
    if ($script:manualClose) {
        $escWatch.Stop(); $timeout.Stop(); Close-All; return
    }
    $k = [Native]::GetAsyncKeyState(0x1B)
    if (($k -band 0x8000) -ne 0) {
        $script:closeReason = 'esc'
        $escWatch.Stop(); $timeout.Stop(); Close-All
    }
})
$escWatch.Start()

# 显示
foreach ($w in $script:windows) { $w.Show() }
$fgDuring = [Native]::GetForegroundWindow()

[pscustomobject]@{
    result             = 'shown'
    seconds            = $Seconds
    scope              = $Scope
    anim               = $Anim
    dpiPath            = $dpiPath
    foregroundBefore   = '0x' + $fgBefore.ToString('X')
    foregroundDuring   = '0x' + $fgDuring.ToString('X')
    noFocusStolen      = ($fgBefore -eq $fgDuring)
    windowCount        = $script:windows.Count
    screens            = $script:screenInfo
} | ConvertTo-Json -Compress -Depth 5 | Write-Output

$script:app.Run() | Out-Null

if ($owned) { try { $mutex.ReleaseMutex() } catch { } }
try { $mutex.Dispose() } catch { }

Write-Output ('{"result":"done","closeReason":"' + $script:closeReason + '","exitAt":"' + (Get-Date -Format 'HH:mm:ss') + '"}')
exit 0
