# attn-ring — 全屏一次性提醒光圈

在显示器最上层显示一个琥珀色圆环光圈，默认 4 秒后自动消失。独立 PowerShell 程序，**不是 DSH 插件**，不装不发布，任何会话/任何工作区可调用。

## 用法（直接复制粘贴）

```powershell
pwsh -NoProfile -File C:\Meru\Seek\tools\attn-ring\Show-AttnRing.ps1
```

**默认行为**（不带任何参数）：显示 **4 秒** / **主屏** / **展开动画**（环从中心放大浮现），到时自动淡出关闭。无需管理员权限，不装任何东西。

### 三个参数

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `-Seconds` | 1–30（整数） | `4` | 显示时长，到时自动关 |
| `-Scope` | `Primary` \| `All` | `Primary` | 只在主屏显示 / 每块显示器各显示一个 |
| `-Anim` | `Expand` \| `Breathe` \| `None` | `Expand` | 展开浮现 / 呼吸明暗 / 静态不动 |

例：全屏呼吸 8 秒——

```powershell
pwsh -NoProfile -File C:\Meru\Seek\tools\attn-ring\Show-AttnRing.ps1 -Seconds 8 -Scope All -Anim Breathe
```

### 怎么关（三种，任选）

- **等**：到 `-Seconds` 自动关（默认 4 秒）；
- **点一下**：鼠标左键点光圈 → 立即关。**这一击被光圈吞掉，不会传给下层窗口**（语义就是"点我一下让我走"，代价是你那一击点不到后面的按钮）；
- **按 Esc**：立即关。Esc 只被**观察**（40ms 轮询 `GetAsyncKeyState`），**不拦截、不吞键**——按 Esc 时你正在用的其它程序也收不到这个 Esc，等价于"看了眼键盘"。

关闭后进程退出，**无托盘图标、无残留进程**（stdout 输出 `done` 行，含 `closeReason`：`timeout` / `click` / `esc`）。

### 状态输出

- 状态**只写 stdout**（两行 JSON：`shown` / `done`），**不落任何文件**——每次调用天然独立，不存在共享状态文件被多写者覆盖/丢行的问题（task-45 E8–E10 实测：共享文件丢数据还 `err=0` 假成功）。**将来若要落盘，文件名必须带 pid 或时间戳，绝不共享固定文件名。**
- 唯一的跨调用共享物是 named mutex `Local\AttnRingOneShot`：它只防「两个光圈同时叠层显示」，**与文件写者无关**（两件事不要混）。

### 启动延迟（取证注意）

从发命令到 `shown` 有 **约 2.3–3.0 秒**引导延迟（Roslyn 编译内嵌 C# + WPF 加载）。要截图/计时**必须先轮询 stdout 等到 `"result":"shown"` 再开始**，否则截到的是黑屏。

## 设计说明

### 当前不感知 presence，将来接 `-RequirePresent`

现在的语义是「**被调用就显示**」，不看用户在不在电脑前。将来接入 presence probe（task-43）时的钩子位置已经定死：

- **加参数**：`Show-AttnRing.ps1` 的 param 块（第 11–12 行，`-Seconds` 旁）加 `-RequirePresent` 开关；
- **gate 位置**：放在 `$w.Show()` **之前**（即设置 timeout DispatcherTimer / `SourceInitialized` 挂原生样式之前）；
- **语义（fail-open）**：内部调 presence probe CLI——probe 说**人不在 → 不显示直接退出**；**拿不到结果/超时 → 当作 present 照常显示**。提醒宁可多不可漏，fail-open。
- **这一版不接的原因**：probe 的 CLI 契约还没定死，现在接 = 猜接口。

### `-Seconds 0`（常驻）与 `-RequirePresent` 必须成对出现

计划中项：`-Seconds 0` = 挂着直到手动关。**它不是独立功能**——单独存在时语义是「没人看也一直挂着」，屏幕被盖住还吞点击，比白闪 4 秒糟糕一个量级。它唯一合理的用法是「挂着直到 probe 说人回来」，即它是 `-RequirePresent` 的伴生参数。**两者必须一起做，这一版都不做。**（参数仍只有 `-Seconds/-Scope/-Anim` 三个。）

## 已知限制

1. **R2 第三档（独占全屏 DirectFlip）未验证**——需要真实播放器进入独占全屏，本机做不到（见下条），未测。
2. **R2 第二档（真实播放器全屏）未验证——但这是沙箱限制，不是光圈的问题**：
   - **现象**：真实播放器全屏档未验证；
   - **原因**：本机沙箱禁止图形进程起窗口——Chrome 起不来（mojo named pipe 被拒，`FATAL … 拒绝访问`）、WMP 进程活着但 6–12 秒内 0 个窗口（不建窗）、WPF `MediaElement` 播真实 mp4 报 `0xC00D11D2`（MF 拓扑构建失败），**三次独立尝试均失败**，这条路在本机走不通，别再试；
   - **替代验证**：用无边框全屏夹具（`rect 0,0,1920x1080`、`WS_EX_TOPMOST`）**等价验证 topmost 冲突**——R2 第二档的真正风险是两层 `WS_EX_TOPMOST` 谁赢，与窗口里播的是不是真视频无关。夹具先显示、光圈后显示，光圈压在其上，同屏截图见 `cangku/261113_g7h_ring-tier2-borderless-fullscreen.png`（**合成夹具**，夹具+光圈同屏验证 topmost 层级）。
3. **Esc 实现是 40ms 轮询 `GetAsyncKeyState(0x1B)`，不是低级键盘钩子**——比钩子更弱干扰（完全不拦截键盘），代价是理论上有 ≤40ms 检测延迟，实测无感。
4. **点击语义 = 吞点击**：点光圈那一击不传下层窗口（R4 拍板语义）。
5. **启动延迟 2.3–3.0 秒**（见上）。
6. **`-Color/-Thickness/-OverlayAlpha/-RadiusPx/-ReassertMs/-Quiet` 参数保留但未实现**——传了会输出 warning 提示「计划中」，不影响显示。**计划中**清单：`-RequirePresent` + `-Seconds 0`（成对）、上述视觉参数、`-Image`（自定义 GIF，方案待拍板）。
7. **DPI**：三级 fallback（进程级 PM_V2 → 线程级 PM_V2 → `GetDpiForMonitor`），本机实测第一级即成功（`dpiPath=process-PM_V2`）；混合 DPI 双屏（120/96）各显示一环已验证（R3 PASS，像素量圆两屏均 `|w−h|=0` 且居中）。

## 验证记录（2026-11-13，全部本机实测）

| 项 | 结果 | 证据 |
|---|---|---|
| 冒烟（显示→4s 自动关→无残留） | PASS | stdout `done` + `closeReason=timeout`，leftover pwsh=0 |
| R1 不抢焦点（`WS_EX_NOACTIVATE`） | PASS | 多轮 `foregroundDuring` 从未等于光圈 hwnd；最强证据：光圈显示中把前台抢回记事本并 SendKeys 打字成功（`*无标题 - 记事本`），光圈不抢回 |
| 点击关 | PASS | 真实用户点击触发 `closeReason=click`（00:46:46） |
| R2 第一档（普通窗口） | PASS | `cangku/261113_a1r_ring-tier1-notepad.png`、`261113_c3m_ring-tier1-notepad.png`（光圈盖在应用窗口上） |
| R2 第二档（真实播放器全屏） | **未验证（沙箱限制，见已知限制 2）** | 三次失败记录 + 合成夹具等价验证 `261113_g7h_ring-tier2-borderless-fullscreen.png` |
| R3 双屏混合 DPI | PASS | `-Scope All` → `windowCount:2`；DISPLAY1 dpi120 `ringDip363` bbox 506×506；DISPLAY3 dpi96 `ringDip378` bbox 422×422；两屏 `\|w−h\|=0` 且中心对齐屏中心；截图 `261113_d4n_ring-both-screens.png` |

## 文件

- `Show-AttnRing.ps1` — 主程序（单文件，WPF 零依赖）
- `ring.cmd` — 双击/任意 shell 的透传入口（`pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0Show-AttnRing.ps1" %*`，不写任何状态文件）
