# 热表 · Hotlist

> 给 DSH Web 界面加一张「热表」——把还热着的会话摆到你手边，凉掉的自己退场。

**Hotlist** is a plugin for the [DeepSeek Harness](https://github.com/) Web UI. It turns your session list into a live, prioritized surface: hot sessions get their own seat in the conversation tab row, the left sidebar grows a per-session status glyph, and every state change can play a sound you recorded yourself.

| 对话区座位 | 侧栏状态标记 |
|---|---|
| ![tab seats](screenshots/tab-seats.png) | ![sidebar glyphs](screenshots/sidebar-glyphs.png) |

| 官方设置页 | 自定义素材 |
|---|---|
| ![settings](screenshots/settings-full.png) | ![uploaded glyph](screenshots/uploaded-glyph.png) |

---

## 它解决什么

DSH 默认只有一个会话列表。会话一多，你分不清哪个在等你、哪个在跑、哪个早就凉了。

热表把「需要你的人」排到最前：

**七类清单，一次看全**

| 类别 | 含义 | 默认图标 | 出现在 |
|---|---|---|---|
| 📌 `pinned` | 你手动钉住的 | 📌 | 对话区 tab、侧栏 |
| ⛔ `error` | Agent 报了错 | ⛔ | 对话区 tab、侧栏 |
| 🔐 `pending` | 等你审批 / 等你回答 / 等你过方案 | 🔐 + ❓ | 对话区 tab、侧栏 |
| ✅ `completed` | 刚跑完、你还没看 | ✅ | 对话区 tab、侧栏 |
| ⏳ `running` | 正在干活（含子代理在跑） | ⏳ | 对话区 tab、侧栏 |
| 💤 `idle` | 最近动过、已经凉了 | 💤 | 仅侧栏 |
| ⭐ `favorite` | 预留 | ⭐ | — |

**排序**：一级 = 置顶 / 报错 / 待审 / 刚完成；二级 = 干活中；三级 = 五分钟内动过的闲置。同一级内可按时间或手动顺序。紧急类（`pinned` / `pending` / `error`）永远不会被数量上限挤掉，最多多出 4 个额外名额并在设置页提示「另有 N 个待处理会话未显示」。

**座位上限自适应**：对话区 tab 行宽度决定能放几个，你也能在设置里写死 1–12。

## 三个显示位置

- **对话区 tab 行**（已实现）：每个会话占一个座位，点它直接切过去
- **左侧会话栏行首标记**（已实现）：每行一个状态 glyph，可以「顶掉」`dsh-sessions-manager` 自带的状态点
- **窗口顶栏**（契约已备，待实现）：一条横排 chip，避开 Windows 标题栏的拖拽带

三者可以任意开关，全关就等于彻底隐身（只留设置页入口）。

## 素材全部可换

- **状态图标**：emoji，或上传自己画的图（默认用二次元头像包，见 `assets/`）
- **每类可存多份，用时随机取一份**——图标按「身份」定种（刷新不换，看着不变），弹出图和音效按「事件」随机（每次都可能不同）
- **音效**：每类进入时播一次，内置 21 条（`pending` / `error` / `completed` 各 7 条），也可上传自己的
- 上限：每池 6 份、图标 ≤16 KB、弹出图 ≤64 KB、音效 ≤128 KB、总计 ≤2 MB

## 安装

```bash
# 从克隆下来的目录安装（DSH 0.2.x，Web profile）
git clone https://github.com/JiaoMeru/session-tab-bar.git
dsh plugin --profile <你的 profile 名> add ./session-tab-bar
```

装完重启一次宿主（`dsh --profile <名>` 或重启桌面端），然后在 设置 → 热表 里配置。

> 包名目前是 `@local/dsh-hotlist`（本地命名空间）。装进 profile 时是 `link:` 依赖，所以改代码只需刷新页面，不必重装。

## 运行时 API

设置页之外，插件暴露了一个小接口，方便别的 AI/脚本一把补完配置：

```js
window.__HOTLIST__.version                    // "4.2.0"
window.__HOTLIST__.settings.get()             // 完整设置对象
window.__HOTLIST__.settings.set({ ... })      // 两级浅合并；改一类时请整体写该类
window.__HOTLIST__.settings.reset()
window.__HOTLIST__.settings.subscribe(fn)
window.__HOTLIST__.assets.list('pending', 'glyph')
window.__HOTLIST__.assets.add('pending', 'glyph', { name, dataUrl })
window.__HOTLIST__.assets.clear('pending', 'glyph')
window.__HOTLIST__.assets.preview('pending')  // 立刻播一次（绕过冷启动与节流）
```

细节见 [docs/EXTENDING.md](docs/EXTENDING.md)。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 模块结构、六条「不知道就会改坏」的约束、判定与排序语义
- [docs/TESTING.md](docs/TESTING.md) — 49 组单测都在验什么
- [docs/EXTENDING.md](docs/EXTENDING.md) — 对外 API、素材格式、批量导入、踩坑

## 已知限制

1. **`Alt+1..9` 跳转未实现**：`dsh-session-hotkeys` 在 capture 阶段抢先并 `stopPropagation`，网页侧官方的 `ctx.shortcuts.register()` 也不放行单 `Alt` 组合。硬抢会和对方持续冲突，所以字段与 UI 保留、标「下一版」。目前提供 `Alt+Shift+[` / `]` 循环。
2. **⛔ 只覆盖 agent 级错误**（`api-session/error`）。工具执行失败不算——它不会中断会话。反过来，**用户拒绝审批导致会话结束会进 ✅**：`running → 非 running` 就是完成转换，与结束原因无关。
3. **宿主自己的 `refreshViews` 会在会话被释放后抛一次** `uiConversation.binding: unknown session`。触发条件是「座位指向的会话被点进去后拒绝/结束」。这不在插件调用栈里，只能全局吞异常，代价大于收益，故不处理。
4. **1.5 秒节流**只有源码与单测口径，真机难以构造连续两次真实状态转换。
5. **窗口顶栏形态**尚未实现（契约已完成）。
6. 设置存在浏览器 `localStorage`，与本机端口绑定；换端口需要重新配置。

## 素材来源

`assets/*.webp` 由作者本人绘制的角色图裁切压缩而来；`assets/sounds/*.mp3` 由作者使用小米 MiMo TTS 生成。两者都可替换为你自己的素材，替换后图片按「≥64px 才用图，再小一律 emoji」的规则渲染——因为 17/24px 的位图会糊成一团。

## License

MIT — 见 [LICENSE](LICENSE)。