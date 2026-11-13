# Changelog

## 5.0.0-alpha.1

**Windows 桌面版顶栏（v5 第一版，alpha）。** 在窗口最上沿那条 40px 标题带里画一排会话胶囊，与对话区 tab 行并存、互不顶替。仍是 alpha：只在开发 profile 与网页预览里验过，桌面真机三条红线（`top===0`/`height===40`、不压左侧菜单与右侧窗控、拖拽带空隙可点）尚未实测。

- **顶栏**：`positions.topbar` 默认开；`shell.overlay` 里一条 `pointer-events:none` 的透明带，胶囊自己 `pointer-events:auto` + `-webkit-app-region:no-drag`，所以拖拽带照旧能拖。左边界用命中测试（`elementsFromPoint`）实测，只认「贴左边且宽度 ≤ 480」的元素——全宽容器不算占位，否则网页版会把胶囊推到屏幕外。窗控一侧写死 `WINDOW_CONTROLS_GUARD = 138`，不属于设置项。网页版默认不挂，靠 `topbar.previewInWeb` 预览。
- **谁出现在哪**：`CATEGORY_SURFACES` 重排——报错/待处理/已完成走顶栏，闲置/置顶走 tab 行，进行中两边都不占；`classify()` 六条分支都过 `categoryVisible()`，类不在本面就整体不出现（不再降级成闲置）。
- **标签显示设置**（`topbar.titleMode`）：`text` 仅显示文本 / `icon` 使用插件图标 / `custom` 自定义显示图标。三档都会剥掉会话名开头那颗 emoji，避免和图标并排成两个 emoji；旧值 `unified`/`two`/`smart` 与 `auto` 全部别名兼容，`SETTINGS_VERSION` 仍 4、无迁移。
- **自定义生效范围**（`topbar.customScope`）：按类别勾选是否用会话名开头的 emoji 替换图标，只在 `custom` 档出现；设置页第二行，六颗 chip。
- **置顶顺序默认 60**（原 15）：`LEGACY_DEFAULTS` 认 `0/1/15` 为老默认，用户自己写过的值照旧保留。
- **侧栏标题归属**：插件会剥掉行标题开头的 emoji 并记住宿主原文，退出时还原；标题被别的插件改写时只 `console.debug` 一次，不动手。
- **导出**：`window.__HOTLIST__.export({format})` 裸调用不再返回空数组；`scope` 三档在拿不到当前工作区时退化为不裁剪，默认 `smart` 不会空列表。
- **失败态修 bug**：原来每次 sync 都按「还在跑」清掉错误标记，而真实 agent 错误恰恰发生在失败那一轮还在跑的时候——真 ⛔ 会被擦掉。改成订阅 `api-session/activity`，只有出现更新的用户消息才清，TTL 兜底。
- **设置页**：三处座位数统一成同一个 stepper（只有座位上限带「自动」）；删「顶栏样式」与「右侧预留」两行（字段保留，API 可写）；单位统一；胶囊宽度 0% 显示「默认」。
- **测试**：93 组（4.6.5 是 65 组）。
## 4.6.5

**修掉 4.6.4 砸死的控件：被预设覆盖的字段，只要用户自己选过，就不再被覆盖。** 4.6.4 没有发布，
所以这版对外的变化是「4.6.3 → 4.6.5」；下面两段一起构成这次升级。

- **新增持久字段 `choices`**（`{ "<path>": true }`）：只有**用户自己写过**的字段才在里面。埋点是唯一写入口
  `writeSettings(patch)`，用**传进来的 patch** 判断（不是合并后的整体）——预设规则在 sanitize 阶段改写值，
  被它改写的不算用户选择。
- **闸门改成 `旧预设 && !choices[path]`**：没动过的字段仍然跟随新默认（4.6.4 的「出厂预设覆盖」保留），
  动过的字段永不覆盖。于是设置页里 `none` / `blink` / 「仅图标」/ 频率 100% / 关音效**都能真正落地了**——
  在 4.6.4 上这些都会回弹成默认值（选了等于没选）。
- **`resetSettings()` 一并清空 `choices`**：恢复默认就是重新认可出厂预设。`backups()` / `restore(i)` 把 `choices`
  和整份设置一起存取。`choices` 是已知字段，不进保留副本；`SETTINGS_VERSION` 仍为 4，无迁移。
- 设置页的 patch 现在只带**改动的那个字段**（`mergePatch` 往下多合一层，`{glyph: {motion}}` 不会再把上传池冲掉）。
- `VERSION` / `package.json.version` → `4.6.5`。

## 4.6.4

- Factory presets now replace older factory presets: a stored value that only ever equalled an
  earlier default (`💤`, `blink`, `none`, frequency `1`, sound off) follows the current default,
  so an existing install finally sees the ice cube and the new motion table. No user choice is ever
  overwritten — a value that is not one of our old defaults is kept byte for byte.

版本号跟 `client.js` 里的 `const VERSION` 一致，也与 `package.json` 的 `version` 一致（后者同时是 npm 分发版本号）。设置数据另有一套 schema 版本（`SETTINGS_VERSION`），两者不同：前者是发布版本，后者只在**数据结构**变化时才动。

## 4.6.3

**只调整默认参数，没有改任何逻辑。**

- **动效默认值**：报错 / 待处理 / 置顶改为「弹跳」并同时作用于标题（`motionTarget: 'row'`），已完成改为「旋转」；进行中仍是旋转，闲置仍是不动。
- **播放频率默认值**：报错 90%、待处理 90%、置顶 30%、已完成 100%、进行中 100%、闲置 0%（闲置不参与动效）。频率仍按「每个节拍掷一次骰子」的概率工作。
- **提示音默认开关**：报错 / 待处理 / 置顶 / 已完成四类默认开启，进行中与闲置默认关闭。
- **闲置图标换成 `🧊`**（冰块）：`💤` 是三个码位挤在一起，13px 下糊成一团；冰块对应「不用的会话已经凉了」，冷色也和其余五类拉开。
- 老安装已存的值原样保留——这批只是默认值，没有迁移，也不覆盖用户改过的东西。`SETTINGS_VERSION` 仍为 4，`VERSION` / `package.json.version` → `4.6.3`。

## 4.6.2

**删掉第 7 类「收藏」+ 最近对话窗口补单位、UI 收窄到 1–36。**

- **`favorite`（收藏）整类删除**：`CATEGORY_IDS` 从 7 类变 **6 类**——`pinned / error / pending / completed / running / idle`。类型、`CATEGORY_ORDER` 里的 `favorite: 60`、设置页那张第 7 卡（以及它的「预留、只读」文案与 `settings.pins.*` 之外的 `favorite` 相关 i18n）、`reserved` 字段一起删掉。**旧数据里的 `categories.favorite` 会被丢弃**（`RETIRED_PATHS`，读时扔掉、写回不再带），不迁移、不报错。置顶不受影响，**仍然接宿主原生置顶**。设置页从 7 卡变 **6 卡**。仓库里 `assets/favorite-*` 五张历史素材也一并删除（`manifest.json` 的类别表同步去掉它）。
- **老安装的旧默认顺序会被自动升级到新默认，逐类判断**：「某个值等于这一类的历史默认」就视为「用户没选过」，换成新版默认；改过的值原样保留。历史默认在 `LEGACY_DEFAULTS` 里：`pinned` 的 `0`（以及最早那版的 `1`）→ 新 `15`、`pending` 的 `20` → `10`、`completed` 的 `30` → `20`、`running` 的 `40` → `30`；`error` 一直是 `10`、`idle` 一直是 `50`，不需要动。所以「一次都没调过顺序」的老安装会整体看到新次序，只改过其中一类的则只保留它那一个值。
- **「最近对话展示时间」补单位、UI 范围改为 `1`–`36`**：字段仍是 `collect.recentWindowMinutes`，**单位是分钟**。存储层夹取仍是 `0`–`120`（`0` = 不显示 `idle`），所以**通过 API 写 90 依然有效并保留**；只是设置页那一行现在只给 `1`–`36`（默认 5），不再让人填 0 或 120。两层范围是分开的两个常量（`RECENT_WINDOW_MINUTES` 管数据、`RECENT_WINDOW_UI` 管界面），改代码时别把 UI 上限当数据上限。旧字段 `categories.idle.within` 仍按原路迁移到它。
- `VERSION` / `package.json.version` → `4.6.2`；`SETTINGS_VERSION` **保持 4**——删掉一个从不产出的类别不构成数据结构破坏，旧数据靠「读时丢弃 + 缺省补全」过关。

## 4.6.0

**置顶改接宿主原生 + 类别顺序与优先级按用户口径重排。**

- **默认展示顺序变了**：`error 10 / pending 10 / pinned 15 / completed 20 / running 30 / idle 50 / favorite 60`。旧版是 `pinned 0 / error 10 / pending 20 / completed 30 / running 40 / idle 50`。`pinned` 不再固定第 0 位，它的 `order` 也变成可编辑的 1–99。
- **判定优先级重排**：一个会话只属于一个类别，从高到低 `error > pending(审批/提问) > completed > running > pinned > idle`。置顶从「最高」降到「只高于闲置」——置顶会话报错了就进 `error`，不再霸着 `pinned`。
- **置顶改接宿主原生置顶**：读 `uiWorkspace.workspaces.list.getSnapshot().pinnedSessionIds`（最近置顶在前），`pinLevel` = 下标 + 1。插件的 `settings.pins`（手工置顶级 map）整块废弃——不再参与 `classify` / `sidebarStateOf`，旧盘上读时丢弃；设置页 `pinned` 卡里的「上移 / 下移 / 取消置顶」一段与对应 i18n 键（`settings.pins.*`）一起删掉。置顶/取消置顶用宿主侧栏行自带的菜单。
- **新增全局设置 `pinned.maxSeats`（默认 `3`，范围 `0`–`12`）**：全局区多一行「置顶最多显示」，`0` = 不显示置顶。`buildSeatPlan()` 里超出这个上限的 `pinned` 行会被丢掉（`pinned` 仍属优先通道，但受这条上限约束）。
- `VERSION` / `package.json.version` → `4.6.0`；`SETTINGS_VERSION` **保持 4**——没有结构破坏性变更，旧数据靠「读时丢弃 + 缺省补全」过关，不写迁移。

## 4.5.0

**设置页减法 + 内置音效换成两个 wav。首个公开版本。**

- **删掉设置页「浮层尺寸」那一栏**（`overlay.sizeMin` / `sizeMax`）。字段与「取中值再按视口收窄」的算法都保留，只是不再有 UI；想改用 API。
- **内置音效从 21 条 mp3 换成 2 个 wav**：`pending` / `error` → `attention.wav`，`completed` → `complete.wav`（`BUILTIN_SOUND`，`client.js:237`）。固定映射、一对一，不再随机挑 7 条之一。旧的 21 条 `*-1..7.mp3` 从 `assets/sounds/` 删除；上传池机制不变。
- 包名从本地命名空间 `@local/dsh-hotlist` 改为 **`dsh-better-notice`**，`package.json` 的 `version` 与 `VERSION` 对齐到 `4.5.0`（此前是 `1.0.0`）。
- 仓库随附 `tools/meru-tts/`：生成这两条提示音用的 TTS 小工具（不参与插件运行）。

## 4.4.0

**设置页按用户反馈做减法，动效改成「播放频率」。**

- 删掉四类行：`hideNativeDot`、快捷键三条（`Alt+Shift+[` / `]` / `S` 的行为全保留，只是不再有 UI）、「全部恢复默认」、「另有 N 个待处理会话未显示」提示条。
- 图标组不再选「尺寸」（固定 20px / 16px），「来源」与「上传」并排一行。
- 每类的动效「平均间隔（毫秒）」→ **播放频率滑块 0–1**（`glyph.frequency`，默认 `1` = 每拍都播，`0` = 不播）；旧值按 `f = 1 − (ms − 2000) / 58000` 迁移。
- `idle` 卡里的「收录窗口」搬成全局 **「最近对话展示时间」**（`collect.recentWindowMinutes`，默认 5 分钟，0–120）。
- **修 `motionTarget:'row'`**：根因不是没命中标题，而是文字 keyframes 只改 `opacity`、肉眼看不出动。给四个文字 keyframes 加 1–2px 位移（不加 scale，避免发虚）。
- 预览改成按播放频率**常驻循环**（原来只播一次，看不出频率感）。
- 修侧栏适配器漏传 `pinned` / `children`：置顶会话现在侧栏也显示 📌，「子代理在跑」也会并入 ⏳。

## 4.3.1

**修一个会让整页起不来的回归**（v4.3.0 引入，公开版首发即中招）。

- 症状：加载后只剩一条 `Failed to load plugins` 横幅，`web boot: 20 entries did not activate`，`ui-workspace` / `ui-open-in-app` / `ui-sidebar-terminal` 直接 `failed`，其余 UI 全 `pending (waiting for service: uiWorkspace)`；console 里 24 条重复的 `locale subscriber crashed: TypeError: command.label is not a function`。
- 根因：宿主要求快捷键命令的 `label` 是 **thunk**——`dsh-client-shortcuts/lib/client.js:1190` 与 `:1249` 都是 `label: command.label()`，直接调用。我们传的是 `t(...)` 的返回值（字符串），于是在 `refreshLabels()` 里抛错，把 `uiWorkspace` 一起拖下水。
- 修法：三处 `registerFixed` 的 label 改成 `() => t(...)`（`client.js:4615-4617`）。
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