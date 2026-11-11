# Changelog

版本号跟 `client.js` 里的 `const VERSION` 一致。设置数据另有一套 schema 版本（`SETTINGS_VERSION`），两者不同：前者是发布版本，后者只在**数据结构**变化时才动。

## 4.3.1

**修一个会让整页起不来的回归**（v4.3.0 引入，公开版首发即中招）。

- 症状：加载后只剩一条 `Failed to load plugins` 横幅，`web boot: 20 entries did not activate`，`ui-workspace` / `ui-open-in-app` / `ui-sidebar-terminal` 直接 `failed`，其余 UI 全 `pending (waiting for service: uiWorkspace)`；console 里 24 条重复的 `locale subscriber crashed: TypeError: command.label is not a function`。
- 根因：宿主要求快捷键命令的 `label` 是 **thunk**——`dsh-client-shortcuts/lib/client.js:1190` 与 `:1249` 都是 `label: command.label()`，直接调用。我们传的是 `t(...)` 的返回值（字符串），于是在 `refreshLabels()` 里抛错，把 `uiWorkspace` 一起拖下水。
- 修法：三处 `registerFixed` 的 label 改成 `() => t(...)`（`client.js:4401-4407`）。
- 为什么没被拦住：单测里 `shortcuts` 是桩，桩不调用 `label()`，所以「传字符串」在单测里永远看不见。补了一组 **`shortcut labels are thunks`** 断言：`typeof spec.label === 'function'`、调用返回非空字符串。教训写进 `docs/TESTING.md`：凡宿主会调用我们传入的回调，桩必须真的调一次。

## 4.3.0

- **快捷键**：`Alt+Shift+[` / `Alt+Shift+]` 循环切换座位（稳定环，当前会话不占座位也能正确前进/回绕）；`Alt+Shift+S` 手动弹一次速查浮层（默认关）。
- 路线走宿主的 `ctx.shortcuts.registerFixed` + `observeFixedInput`，不自建 `keydown`；`shortcuts` 是软依赖，服务缺失时座位照常挂载。
- 修掉 `cycleSeat` 的一个真 bug：原来用 `cycleIds.indexOf(current)` 定位，而当前会话永不出座 → index 恒 -1，按几次都跳回同一头/尾。
- 图标定种去掉时间锚（`${sessionId}|${category}`），同一会话在同一类别里刷新不再换图；`enteredAt` 整表删除。
- 设置页 shortcuts 区接线（`overlayEnabled` 真开关、`jumpEnabled` 恒灰「下一版」、只读键位行）。
- 文档补两条语义：**拒绝/中断也算完成**（`running → 非 running`）、**宿主 `refreshViews` 在会话释放后会抛一次**（不要用全局 `onerror` 兜）。

## 4.2.0

- **音效真的会响**：每类进入时播一次，三道闸——冷启动首轮不播（armed）、同会话同类去重（离开即清）、全局 1500ms 节流。`sound.enabled` 默认关。
- **内置 21 条音效**（`pending` / `error` / `completed` 各 7 条），打包进插件，由 host 半边注册 `/hotlist-sound` 前缀路由自服务（DSH 的 package-asset 路由只认图片，`.mp3` 会 404）。
- **素材池**：图标 / 弹出图 / 音效每池最多 6 份，用时随机取一份。图标按「身份」定种、弹出图与音效按「事件」随机。
- **对外 API**：`window.__HOTLIST__.{settings,assets}` + `docs/EXTENDING.md`。
- 旧 `sound.kind`（`none` / `chime1` / `chime2` / `alert`）读时迁移成 `{enabled, builtin, uploads}`。

## 4.1.0

- 七类清单模型落地：`pinned` / `error` / `pending` / `completed` / `running` / `idle` / `favorite`（预留）。
- 设置页改卡片式：7 张折叠卡 + 位置前缀行 + 五组（图标 / 动效 / 弹出 / 音效 / 顺序）；展开态高度从 1315px 收到 ≤520px；支持多卡同开（`sessionStorage`）。
- 每类独立「平均动效间隔」；删掉「减少动效」「原生点可见时」「同时播放动效上限」「会话跳转快捷键」等行。
- ✅ 持久化到 `localStorage`（7 分钟 TTL），修好「刷新后 ✅ 立刻消失」——根因是宿主 `sessions.list` 首拉前 `phase !== 'ready'`，剪枝把条目全删了。
- 图标定种种子去掉时间锚，刷新后不再换图。
- `hideNativeDot` / `takeOverStatusDot` 真正接线。

## 3.1.0

- 侧栏状态标记适配器（`createSidebarAdapter`）：DOM 增强插 glyph，不改宿主结构，卸载逐项还原（`misses() === 0`）。
- 官方设置页 `settings.section` 落地：全局区 + 8 状态表单（后来在 4.1 换成 7 卡）。
- CSS 动效五件套（spin / pulse / bounce / blink / none），只用 `transform` / `opacity`，`prefers-reduced-motion` 降级。
- 接管 `dsh-sessions-manager` 的状态点（注入 `[data-dsm-dot]{display:none !important}`），并保留其归档/回收站/星标等其余功能。

## 3.0.0

- 三级排序成型：待审 / 报错 / 刚完成 → 干活中 → 五分钟内闲置。
- 状态判据换成宿主真实数据（`uiSession.sessionStatus` 的 `running` / `pendingInteraction.kind` / `completionUnread`），⛔ 由自采 `api-session/error` 补齐。

## 2.1.0

- 座位 id 加 `hotlist-seat-` 前缀 + 模块加载时自愈 `localStorage` 里的视图偏好。此前座位注销会把持久化的 `view` 留成「不存在的视图」，触发 React #185 整页白屏。
- 座位注销延后到下一个宏任务，避开宿主 `refreshViews` 在会话释放窗口内抛 `binding: unknown session`。
- `healViewPreferences` / `repairSourcePreference`：切换会话时把源会话的 `view` 写回 `chat`。

## 2.0.0

- 每个会话占一个 `conversation.view` 座位（不再是「一个 tab 里套列表」）。
- 当前会话永不出座（它本身就是「对话」tab）。

## 1.0.0

- 第一个版本：注册 `conversation.view` 座位，面板里列出当前工作区的会话，点击切换。

## 0.x

- 调研阶段：确认 tab 行由 `slots.entries('conversation.view')` 渲染，座位注册 `{name, id, label, order}` + 组件即可；切会话走 `ctx.get('uiWorkspace').openSession(id)`。