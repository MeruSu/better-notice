# 热表架构（维护者文档）

目标读者：下一个要改这份代码的人。看完应该能回答三件事——状态从哪来、三种显示位置各自怎么挂、哪些地方看起来"脏"但**换干净写法会更糟**。

所有行号对 `client.js`（4546 行，v4.3.0）。

## 1. 分层与真实名字

```
                 ┌────────────────────────────────────────┐
数据源  ────────►│ 纯判定层（无 DOM，可单测）             │
sessions.list    │ sanitizeSettings        client.js:766  │
uiSession.       │ classify                client.js:1271 │
  sessionStatus  │ sortSeats               client.js:1332 │
workspaces.list  │ buildSeatPlan           client.js:1354 │
api-session/error│ sidebarStateOf          client.js:1624 │
                 │ findRowTitle            client.js:1604 │
                 │ shortenTitle            client.js:1211 │
                 │ labelOf                 client.js:1391 │
                 └───────────┬────────────────────────────┘
                            │ plan / row 判定
        ┌───────────────────┼────────────────────────┐
        ▼                   ▼                        ▼
  tab 座位适配器        侧栏 glyph 适配器         设置页
  mountTabSeats         createSidebarAdapter      HotlistSettingsPage
  client.js:4087        client.js:1646             client.js:2366
  disposeTabSeats       start/refresh/stop/misses
  client.js:4127
```

**与任务书用词的差异（别按旧名字找函数）**：代码里没有 `buildMarkerPlan()`、`createTabSeatsAdapter()`。

- 判定拆成两步纯函数：`classify()` 判类别与 token，`sortSeats()` 同级排序，`buildSeatPlan()` 再套上限并给出 `order`。三步都不碰 DOM，可以单独喂假数据测。
- tab 适配器不是独立工厂，而是 `apply()` 内的 `mountTabSeats()` / `disposeTabSeats()`；它需要一个活着的 `ctx`（注册 slot、读写 store），抽成工厂反而要传一堆依赖。
- 侧栏适配器是真正的工厂 `createSidebarAdapter(options)`，接口为 `start() / refresh() / stop() / misses()`（不是 `mount/update/dispose`）。它自己遍历宿主 DOM，不接收 plan——因为一行一行读宿主更简单，而 tab 必须先把 plan 算好再看能放几个。

新增一个显示位置时，照 `createSidebarAdapter` 的形状写一个工厂：**只读 store、只写自己的节点、提供 `stop()` 全量还原、带 `misses()` 自检**，然后像 `sync()`（`client.js:4228`）那样由位置开关驱动 start/stop。不要改 `classify`/`buildSeatPlan`/`sidebarStateOf`。

## 2. 数据源（唯一权威，全部只读）

| 来源 | 取法与语义 | 官方依据 |
| --- | --- | --- |
| `ctx.get('sessions').list.getSnapshot()` | `{ids, byId, phase, projectionsBySession}`。`byId[id]` = `{id, displayTitle, running, retainedBy, blank, updatedAt, projectionValues, title?, cwd?, parentId?, origin?}` | `dsh-api-session-controller/lib/client.js:3830-3835`，字段 `:4169-4182`，子代理补行 `:4192-4235` |
| `updatedAt` | 最近活动（ms），= `max(summary.updatedAt, lastPromptAt)`；**子代理行恒 0** | `:3610` |
| `projectionsBySession[id].values.subagentCatalog` | 子代理清单；子会话在 `sessionStatus` 里 running 就算父会话"在干活" | `runningChildren()`，`client.js:1248` |
| `ctx.get('uiSession').sessionStatus.getSnapshot()` | `Map<id, {running, pendingInteraction:{kind}|null, completionUnread}>`；唯一的状态权威 | `dsh-client-ui-session/lib/client.js:782-790`，快照 `:999-1004`，`completionUnread` 置/清 `:964-981` |
| `ctx.get('uiWorkspace').workspaces.list.getSnapshot()` | `{items:[{workspaceId, sessionIds,…}], archivedSessionIds}`；用于"只列当前工作区" | `dsh-client-ui-workspace/lib/client.js:1553` |
| 当前会话 | `byId[*].retainedBy.mainView > 0`（不读 `selection`，避免和持久化快照时序打架） | 侧栏同一规则 `dsh-client-ui-workspace/lib/client.js:876-878` |
| 运行失败 | `ctx.remote.$on('api-session/error', (sessionId, message))`（live-only）+ 已打开会话 `sessions.binding(id)?.session.getSnapshot()` 的 `promptError.error.message` / `lastAgentError` | relay `dsh-api-session-controller:4294`，快照 `:2910-2935`，`promptError` 形状 `:2372-2375` |
| 切会话 | `ctx.get('uiWorkspace').openSession(sessionId)` | `dsh-client-ui-workspace/lib/client.js:1473-1475` |

`pendingInteraction.kind` 只有三种：`approval` / `question` / `plan-review`（审批 `dsh-client-ui-approval:223-225`，提问 `dsh-client-ui-user-questions:2249`）。没有独立的 `subagents` 信号，v4 把"子代理在跑"并进 `running`。

## 3. 座位 id、`heal`、`repair` —— 三件互相配套的事

- 座位是 `conversation.view` 的一条注册，id 为 `hotlist-seat-<sid>`（`SEAT_PREFIX`，`client.js:84`；历史前缀 `seat-` 见 `SEAT_PREFIXES`，`client.js:86`）。
- **为什么必须是前缀 id**：宿主把"每个会话当前选中的 view id"持久化进 `localStorage['dsh.conversation.<sessionId>']`（`dsh-client-ui-conversation:4560-4571`）。如果座位 id 就是裸 sessionId，用户点一次座位，源会话的偏好被写成"我的座位页"；座位注销后该 view 不存在，宿主 `resolveActiveView`/`restoreView` 互相激活 → React #185（Maximum update depth）直到人肉清 localStorage。真机事故记录：`cangku/261111_cr8_react185_crash.png`。
- `healViewPreferences()`（`client.js:1428`）在模块加载时扫所有 `dsh.conversation.*`，把指向 `hotlist-seat-*` / `seat-*` / `session-switcher` / `hotlist` 的偏好改回 `chat`（`isSeatViewId`，`client.js:1423`），其它字段原样保留。
- `repairSourcePreference()`（`client.js:1455`）补一个更细的竞态：宿主会在我们 `openSession(target)` 之前先写源会话偏好，所以"离开时 activate chat"仍可能被覆盖；在 `settle()` 的开头、250ms、1200ms 三处再修一次源会话的偏好。**这是补偿宿主时序，不是绕过 API**（没有"设置某会话 view"的公开 API）。

## 4. 座位顺序：类别 order + 类内序号

- v3 的"tier + 进入戳"已随 v4 判定层一起删掉。现在顺序完全由设置决定：跨类别按 `categories[<id>].order` 升序（`orderedCategories()`，`client.js:1224`；同 order 时按 `CATEGORY_ORDER` 兜底稳定），类内按 `sortBy` 排（`sortSeats()`，`client.js:1332`）：`time` = `updatedAt` 倒序，`manual` = 按 `pinLevel`（只 `pinned` 用它）。
- 座位 `order = categories[<id>].order * 100 + 类内序号 + 1`（`client.js:1380`）。因此**只要一个座位没换类别、且前面没人增删，它的 order 就不变**——宿主不会因为 30s 的 `sync()` 重排而抖动。
- **不要把 `updatedAt` 直接映射成 order**：宿主每次注册/注销都会 `ctx.emit('slots/changed')`（`dsh-client-ui-renderer:1349-1351`）→ conversation 的 `refreshViews` 遍历所有 binding 做 `restoreView`（`:22629-22660`）。频繁重排 → 反复注销/重注册 → 每次都有机会把某个刚释放的 session 喂进 `binding()`，抛 `uiConversation.binding: unknown session`，并且 active view 会短暂落回 chat。`updatedAt` 只用于类内 `sortBy:'time'` 的排序键；同一批里并列时用 `sessionId` 兜底，保证两次计算结果一致。
- 用户在设置里改某类的 `order`，该类所有座位会一次性换 base（一次重注册），这是预期代价。
- **三层语义在 tab 面上仍然成立**：tier1 = `pinned` / `error` / `pending` / `completed`（用户可行动或刚刚产出），tier2 = `running`，tier3 = `idle`（`within` 窗口内更新过的普通会话）。因此 `CATEGORY_SURFACES.idle.tab` 默认是 **true**（`client.js:126`）——用户原话是"五分钟内的会话都加入到那个列表，位于第3级"，把第三级从 tab 面默认关掉等于删掉他明确要的东西。想降噪的用户可以只关 `idle.surfaces.tab`（侧栏保留），这是**可选**手段，不能当默认。

## 5. 上限：物理宽度 ∩ `maxSeats`，紧急类另有硬顶

官方规则：可见 tab 数 = `max(1, floor((rowWidth - 48) / 120))`，超出折叠进一个**点不到**的溢出菜单（`dsh-client-ui-conversation:20814-20831`）。所以上限必须自己算（`seatLimit()`，`client.js:3925`）：

1. 量 `[data-conversation-tabs]` 的**父元素**（`div.an3WzG_tabs`）。tablist 自己是内容宽（实测恒 204px），量它必得 1。
2. `visible = max(1, floor((width - TAB_ROW_PADDING) / TAB_WIDTH))`，常量 `TAB_WIDTH`/`TAB_ROW_PADDING`（`client.js:96-97`）。
3. 给 chat + trajectory 留 2 个位置，返回 `max(1, visible - 2)`。
4. 量不到（0）时回退 6（`FALLBACK_LIMIT`，`client.js:94`）。
5. 最终上限 = `min(settings.maxSeats, seatLimit())`，`maxSeats === 'auto'` 时取 `seatLimit()`（`client.js:3925`）。

`buildSeatPlan()` 的裁剪（`client.js:1354-1388`）：`pinned` / `pending` / `error` 是"要人处理"的类别，**不按 `limit` 裁**，但受硬顶 `limit + ALWAYS_OVERFLOW`（= `limit + 4`，常量 `ALWAYS_OVERFLOW` `client.js:154`）约束；其余类别（`completed` / `running` / `idle`）填到 `limit` 为止。被裁掉多少记在 `plan.overflow`，给设置页提示用。宁可挤一点，也不把要人处理的会话藏起来；但 10 个待审全出座位会把 tab 行挤爆，所以硬顶必须有。

## 6. 刷新与订阅的分工

| 触发 | 频率 | 干什么 | 位置 |
| --- | --- | --- | --- |
| `sessions.list.subscribe(sync)` | 数据变即触发 | 会话增删、标题、updatedAt | `client.js:4473` |
| `uiSession.sessionStatus.subscribe(sync)` | 数据变即触发 | 三状态字段变化 | `client.js:4474` |
| `workspaces.list.subscribe(sync)` | 数据变即触发 | 工作区归属、归档 | `client.js:4475` |
| `setInterval(sync, 30s)` | 30s | `idle.within` 窗口、`collect.completedTtlMs` 过期、失败标记过期 | `REFRESH_MS` `client.js:91`，定时器 `client.js:91` |
| `window resize`（防抖 200ms） | — | 重算 `seatLimit()` | `seatLimit` `client.js:3925`，监听 `client.js:3925` |
| `onSettingsChange` | 写入即触发 | 座位与图标立刻反映设置页 | `client.js:1095` |
| 侧栏内部 1s tick / 30s 全量刷新 | — | `document.hidden` 暂停动效；缓慢兜底 DOM 抖动 | `SIDEBAR_TICK_MS`/`SIDEBAR_REFRESH_MS` `client.js:1524`/`client.js:1524` |

`sync()` 是唯一的收敛点（`client.js:4228`）：读快照 → 记完成态 → 清失败标记 → 读设置 → 按位置开关 start/stop → 算 plan → 挂座位 → 刷侧栏。不要在别处直接改座位。

### 6.1 短读保护（shrink guard）与座位记忆

真机 bug：切换后约 70 秒座位从 5 掉到 2 且不回来——宿主的列表快照短时间缺行。处理（`client.js:4283-4291`、`restoreRecentSeats` `client.js:4186`）：

- 只有"已注册座位的会话从 `list.ids` 消失"才算真的要撤；先记 250ms（`SHRINK_CONFIRM_MS`，`client.js:101`）后二读，两次都缺才撤。
- 撤下的座位进 `recentSeats`：60 秒内会话回来，用**原来的 order/label** 直接恢复，不必重新排队。
- 由我们自己的规则导致的撤座（当前会话、掉出窗口、`maxSeats`、类别 `surfaces` 关、工作区、归档）仍然立即撤。

## 7. `takeOverStatusDot` 为什么是两层

另一插件（dsm）的状态点不在我们的 slot 里，也没有"禁用某插件"的 API。所以：

1. **CSS 层**：只在开关打开时注入 `<style data-hotlist-style="takeover">`（`TAKEOVER_STYLE`，`client.js:1575`；注入/移除 `ensureTakeover`，`client.js:1689`）。
2. **inline 兜底**：如果点仍可见（对方的 MutationObserver 重建、或 CSS 被覆盖），对点写 `display:none!important` 并记下原值；关开关时先移除 style 再逐点回填原 inline 值（`restoreDots`，`client.js:1722`）——**不删对方节点、不卸载对方插件**。

同理 `hideNativeDot` 不写 inline，而是给行加 `data-hotlist-hide-native` 属性，由我们自己的样式表隐藏 `[data-state]` 本体（`SIDEBAR_STYLE`，`client.js:1544`）；卸载时删属性即还原。

拼接选择器时**只用 `ROW_SELECTOR` 常量原样插入**（它自带方括号）。曾经写成 `[${ROW_SELECTOR}]` → 生成 `[[…]]`，浏览器整条丢弃，两个开关同时失效（v3.0 真机 bug）。测试里有一条断言扫描所有 style 文本不含 `[[`。

## 8. 侧栏 DOM 增强的边界

- 只插入一个 `span[data-hotlist-glyph]` 到**标题 span 之前**（`findRowTitle`，`client.js:1604`：`_title` 类名 → 文本等于 `displayTitle` → 非时间文本 → 第二个 span；找不到就只动图标并 debug 一行，绝不抛）。
- 我们自己的节点**绝不带 `data-state`**，也不放文本节点（emoji 用 `::before{content:attr(data-hotlist-char)}`，方图用 `<img alt="">`），避免被宿主的选择器或无障碍树误认。
- `motionTarget:'row'` 时对**宿主标题**写 inline `animation`（同 keyframes、同相位），停用/换状态/卸载时还原原值（`applyMotion`，`client.js:1863`）。文字动效只许 `opacity`/`translate`，禁 `scale`（字会糊）。
- `MAX_MISSES=60`（`client.js:1516`）：连续找不到行/标题就整块停用（删自己的节点与样式），30 秒后再试，避免在 DOM 大改后继续乱贴。
- **tab label 是字符串管线**：`dsh-client-ui-conversation:20767-20776` 用 `{label}` 画文本，所以 tab 上只有 emoji，不能放图片（图片只能进我们自己的 React 树：设置页预览、未来的顶栏/浮层）。

## 9. 注销为什么延迟

注册/注销都会触发宿主的同步刷新链（见 §4）。会话**离开集合**时：

- 不立即 dispose：`scheduleDisposals()`（`client.js:4060`）= `setTimeout(0)` → `requestAnimationFrame` → `setTimeout(0)` 才真正卸载，让宿主先跑完自己的 unmount 清理。
- 同一个 id 要重建时**同步**先 dispose 旧句柄（否则 duplicate id）；插件卸载/`disposeTabSeats()` 也同步 flush（`flushDisposals`，`client.js:4041`）。
- 收益：真机上我们自己不再成片刷屏。**这是缓解竞态，不是修复宿主**——注释里已写明。
- **宿主自己会抛一次，别去兜**：座位指向的会话被点进去之后用户拒绝审批 / 会话结束，宿主 `refreshViews` 会在会话释放后抛 `Uncaught Error: uiConversation.binding: unknown session "<id>"`（真机 4 次拒绝各 1 条；栈 `UiConversation.binding → activateView → restoreView → refreshViews → OI.flush`，`dsh-api-session-controller/lib/client.js:4067-4074` 的 borrow 语义）。触发条件是「会话已释放、宿主还没清自己的座位表」。**不要加 `window.onerror` 全局吞**：它会盖掉我们以后真出的错，而且这个异常不在我们的调用栈里。我们只负责延后注销 + `phase === 'ready'` 闸门。

## 10. 设置模型与版本

- 形状（`defaultSettings()`，`client.js:243`）：`version / maxSeats / positions{tab,topbar,sidebar} / takeOverStatusDot / hideNativeDot / display{reduceMotion} / shortcuts{jumpEnabled,overlayEnabled,overlayKey} / overlay{side,sizeMin,sizeMax,fallbackImage} / collect{completedTtlMs} / sound{volume} / pins{<sid>:level} / categories{7 类 × 26 字段}`。
- 每类字段（`defaultCategory()`，`client.js:209`）：`enabled / reserved / order / sortBy / pinLevel / surfaces{tab,sidebar,topbar} / glyph{kind,value,source,motion,motionTarget,motionIntervalMs,size,uploads[]} / glyphSecondary / popout{enabled,builtin,images[],displayMs,entrance,ambient,exit,side} / sound{enabled,builtin,uploads[]} / within`。音效音量是**全局** `sound.volume`，类别里只剩种类与开关。
- `SETTINGS_VERSION = 4`（`client.js:82`）。v4.1 只改字段形状、没有升版本号（旧记录经 `sanitizeSettings` 逐字段回落即可）：`display.motionWhenNativeVisible` / `display.maxAnimated` / `overlay.scale` 已删，新增 `glyph.source`、`glyph.motionIntervalMs`、`overlay.sizeMin/sizeMax`、顶层 `sound.volume`。同理 v3 的 `overlay.scale` 倍数在迁移里直接丢弃（只读 `overlay['scale']` 做兼容分支已删），尺寸回落到 260/520。
- 迁移链：
  - **v1（2.x，「会话 tab」时代）**：`{completedTtlMs, maxSeats}`，键 `dsh.session-switcher.settings`（`LEGACY_SETTINGS_KEY`，`client.js:106`）。
  - **v2（2.5 更名「热表」）**：同形状，新键（`SETTINGS_KEY`，`client.js:105`）；读旧键后写新键并删旧键。
  - **v3（3.0 / 3.1）**：`states.<state>.{kind,value,motion,motionTarget,follow,reserved}`、`positions` 三布尔、`display`，删 `placement`。
  - **v4（4.0 / 4.1）**：8 个 `states` 收成 7 个 `categories`，新增 `pins`/`collect`/`sortBy`/`within`/`glyph.size`/`popout`/`sound`/`surfaces`；`overlay.enabled` 分发到各类 `popout.enabled`；`maxSeats` 上限 20 → 12。4.1 在同一版本号内换了形状（见上）。
- 迁移实现：`migrateSettings()`（`client.js:894`）。`version === SETTINGS_VERSION` 走 `sanitizeSettings`；**其它任何版本一律按 v3 表迁移**（`migrateFromV3`，`client.js:845`），因为用户真实数据只有 v3 一种形态。曾经的 alpha 工件把 `version: 5` 写在 v4 形状上，所以迁移里额外把 `categories/collect/pins` 三张表浅合并过去（`client.js:877-878`）——这不是一条迁移链，只是兼容那个中间态；4→5 那种"只改版本号"的幽灵迁移已删。
- `sanitizeSettings()`（`client.js:766`）是纯函数，从默认值起算，逐字段独立回落：非法值只回落该项，不整份作废。`reserved` 类（`favorite`）在 `sanitizeCategory` 里短路（`client.js:702`），前端改不动。
- 旧键只读兼容：`states` / 扁平 `glyphs` / `motion` / `showIdle` / 顶层 `completedTtlMs` / 旧 `overlay.*`。写入侧由 `upgradePatch()`（`client.js:1104`）把旧键映射回 v4 字段，再 `mergePatch()`（`client.js:1154`）逐类合并；读取侧不再有 v3 投影（设置页已经直接读 v4）。
- 对外 API：`window.__HOTLIST_SETTINGS__`（`client.js:1484`，旧名 `__SESSION_SWITCHER_SETTINGS__` 同对象 `client.js:1485`）。`override()` 是测试缝（注入内存 patch），生产不要用。
- 同页写入靠 `notify()`（`client.js:1085`）广播；`watchStorage()`（`client.js:1192`）只负责**跨窗口**（`storage` 事件同页不触发）。

## 11. 扩展点

**加一个类别**：`CATEGORY_IDS`/`CATEGORY_ORDER`（`client.js:118-119`）、`CATEGORY_GLYPHS`（`client.js:123`）、`CATEGORY_MOTION`（`client.js:124`）、`CATEGORY_SURFACES`（`client.js:126`）、`CATEGORY_OF_TOKEN`（`client.js:184`）、`classify()` 的判定分支（`client.js:1271`）、`sidebarStateOf`（`client.js:1624`）、`buildSeatPlan` 的 `always` 集（`client.js:1358`）、ZH/EN 字典（`client.js:273` 起）、设置页卡片循环；再加单测。

**加一个显示位置**：`defaultSettings().positions` 加键（`:229`）、`positionsOf`（`:244`）加派生、`sanitizeSettings` 里保留布尔（`:659-661`）、写一个适配器工厂并让 `sync()` 开关它（`:3824-3846`）、设置页加卡片。不要动 plan。

**改快捷键**：已接线，实现在 `ctx.inject(['shortcuts'], …)` 块里（`client.js:4387`）。**不要**自己 `window.addEventListener('keydown')`——官方有 `ctx.shortcuts`（`@deepseek-ai/dsh-client-shortcuts`）：`register`（可被用户改键）/ `registerFixed`（固键）/ `observeFixedInput`（自己分派），都返回幂等 disposer，用 `ctx.effect` 交给 Cordis 回收。注意 `Alt+1..9` 在 web 端被 `isWebBindingAllowed` 拒（裸 Alt+数字），第三方 `dsh-session-hotkeys` 又会在 capture 阶段抢键；`Alt+Shift+[` / `]` 与 `Alt+Shift+S` 可行。`registerFixed` 只负责显示（它不做 region/modal/repeat 过滤），所以全部守卫写在 `observeFixedInput` 里：`gesture.repeat/composing/defaultPrevented/control/meta` 任一成立就放行原事件；`context.region !== 'page'` 让位给输入框；`context.modal !== null` 让位给菜单/对话框（`modalSelector` 含 `role=menu`）；两条都过了才 `input.consume()`。`S` 还要求 `shortcuts.overlayEnabled === true`（默认关）。

**暴露成客户端服务**（让别的插件 `ctx.get('hotlist')`）：本插件目前**没有** provide 任何 Cordis 服务；官方服务的写法是 `class X extends Service { constructor(ctx){ super(ctx,'uiWorkspace') } }`（`dsh-client-ui-workspace/lib/client.js:1361/1382`）。照此加一个 `Service` 子类并在 `apply()` 里实例化即可；建议只暴露只读的 `classify`/`snapshot()`，不要暴露 adapters。

## 12. 版本与标记（验收脚本依赖）

- `VERSION`（`client.js:82`）→ `window.__HOTLIST_VERSION__`（`client.js:3757`，旧名别名 `client.js:3758`）、座位 body 的 `data-hotlist-seat` / `data-hotlist-version`（`client.js:4013-4014`）、设置页根 `data-hotlist-settings="v4.3.0"`（`client.js:2886`）。
- 设置页行选择器 `[data-hotlist-row]`；侧栏 marker `span[data-hotlist-glyph]`；我们注入的样式都带 `data-hotlist-style`（`sidebar` / `takeover` / `page`）。

## 13. v4.3 已落地与还没接的行为

设置页是 7 张折叠卡（`data-category`，可多开）+ 全局区，紧凑多列排版（折叠 ≈40px、展开 ≤520px）；浮层已接线（§14）+ 完成时间已落盘（§15）；动效按类抽签（§16）；音效与素材池（v4.2）、两条循环热键（v4.3）都已接上。仍是「只存值不接行为」的：`shortcuts.jumpEnabled`（`Alt+1–9` 被占用，设置页恒灰）、`overlay.fallbackImage`（没有 UI）、`surfaces.topbar` / `positions.topbar`（恒 false，等顶栏）。

## 15. 「刚完成」为什么要持久化

`✅ completed` 是热表自己算出来的：宿主只把 `completionUnread` 维护 1–3 分钟、打开会话立刻清（`dsh-client-ui-session/lib/client.js:964-981`），不够用。所以热表自己记 `running true→false` 与 `completionUnread false→true` 两个跳变（`observeCompletion`，`client.js:3886`），时间放 `completedAt` Map。

- **拒绝 / 中断也算「完成」**：判定只看 `running true→false`（`observeCompletion`，`client.js:3886`），与「为什么结束」无关。用户拒绝审批导致会话结束时，该会话进 ✅（我们的自记 `completedAt`），**不是** ⛔；⛔ 只覆盖自采的 `api-session/error`（agent 级错误）。语义是对的：用户处理完了，就该从 tier1「等你」掉下来。

**只在内存里放会丢一个真问题**：页面一重载（改设置、刷新、端口重启）所有 ✅ 都变回 idle，用户看到的"刚跑完"列表凭空消失——这正是 v4.1 之前的行为，验收里被判为缺陷。于是：

- 键 `dsh.hotlist.completedAt.v1`，值 `{version, entries: {<sessionId>: <ms>}}`；`COMPLETED_AT_KEY` 写成正则字面量并取 `.source` 落盘——预重启闸门会先抹掉字符串再搜键名，写成普通字符串它就看不见（RegExp 直接当 key 用会把两侧斜杠带进 localStorage）。
- 读（`readCompletedAt`，`client.js:1009`）：按 `collect.completedTtlMs` 剪掉过期、丢掉非字符串 id / 非有限时间戳、坏 JSON 整体回落空表，**永不抛**。
- 写（`persistCompletedAt`，`client.js:1022`）：500ms 合并（`COMPLETED_FLUSH_MS`），一批跳变只落一次盘；`forgetFinished(id, true)` 是"用户已经打开这个会话"的路径，**同步落盘**，不能让 ✅ 在盘上多留一秒；插件卸载时 `flushCompletedAt()` 兜底。
- 剪枝还看工作区：`snapshot.workspaceIds` 里没有的 id 一律 `forgetFinished`——别的窗口的完成表不属于这个窗口。
- **列表没拉完就不许剪枝**：`sessions.list` 快照带 `phase`（`dsh-api-session-controller/lib/client.js:2995` 构造时 `'pending'`，`:3283` 首拉 `session.list` 成功才 `'ready'`）。`observeCompletion` 开头 `if (snapshot.list.phase !== 'ready') return;`——否则 reload 后首轮 sync 拿着"只到了几行"的快照，把刚从盘上读回来的时间戳全判成"会话不存在"删掉。真机日志：1201ms 时 `rowN=8 / tabN=0` 就写回了 `{}`。单测 `completedAt persistence` 覆盖三条：pending 不剪、ready 才剪、当前会话同步删。
- 只持久化 completed。`error` 是 live-only（重连不补发），`idle` 是时间窗口，都不该落盘。

## 16. 动效为什么是"抽签"而不是"常亮"

旧做法是给每个座位加 CSS 无限动画并按 `maxAnimated` 截断，结果是整屏图标一起转、看不出重点。现在：

- 每个类别有自己的 `glyph.motionIntervalMs`（默认 8s，2–60s，`0` = 该类永不动）；侧栏适配器的 1s ticker 里按类记账（`motionClock`），到点的类掷**一次**骰子（`Math.random()`，`MOTION_BURST_CHANCE=0.5`），命中才从该类里随机挑**一个**座位播一遍单程动画（`MOTION_MS{spin:2400,pulse:1600,bounce:1200,blink:1200}`）。
- 并发上限 `MOTION_CONCURRENCY=2`：两个座位正在动时，后来的类**连骰子都不掷**（所以单测能断言"随机数调用次数"）。
- `reduceMotion: 'on'` 一次全停且不再掷；`display:hidden` 时 ticker 只切暂停属性；卸载/`stop()` 清掉所有 burst 定时器。
- 动画本身仍是纯 CSS（`hl-spin` 等 + 单程变体 `hl-spin 2.4s linear 1`），`row` 目标用只改 `opacity`/`translate` 的 `hl-text-*`（文字不能缩放）。
- 键名 `data-hotlist-burst` 标记"这一轮正在动"，验收脚本与单测都靠它数并发。

## 14. 浮层（popout）：素材、kit 与调用方分工

素材与 kit 的权威副本都在 cangku（不属于发布物）：设计稿 `cangku/tmp/hotlist-art/popout-kit.js`，接线契约 `cangku/tmp/hotlist-art/v4-popout-integration.md`。进插件的是**内联副本**（`client.js:2901-3369`，kit 段注释在 `client.js:2901`）：`TIERS` / `SCALES` / `KIT_TIMING` / `KIT_CSS` / `mountPopout` 等逐字照抄，只加了一个选项 `isReduced`（产品级 `display.reduceMotion` 推导不出系统偏好，由调用方算完传进来）。改动画常量要两边一起改，并同步 `assets/manifest.json`。

- **素材**：`assets/<category>-<tier>.webp`（`TIERS=[64,320,780,1560]`，选档由 `tierFor(cssPx,dpr)` 算）；离线或缺档回落到 `assets/<category>.svg`（`fallbackRef`，`client.js:2977`），再回落 emoji（`KIT_EMOJI`）。`assetRef`（`client.js:2972`）拼的是 `plugins/@local/dsh-hotlist/assets/…`，由 `makeResolveAsset`（`client.js:3377`）区分三种输入：`data:` 原样、`builtin:<cat>` 或空串走内置、其余当 asset id；**任何分支都不抛**。实际加载走模块 loader 的 `require.asset`（`@deepseek-ai/dsh-client-modules/lib/client.js:844`）。
- **尺寸**：v4.1 起由全局 `overlay.sizeMin/sizeMax` 决定——`show()` 取两者中值传给 kit（`size`），不再有 `overlay.scale` 倍数；`resolvePopoutSide` 决定左右。
- **谁决定什么**：kit 只画一只「人」，不管时机。调用方 `createPopoutController`（`client.js:3402`）负责——`resolvePopoutSide`（`client.js:3383`）把 `auto` 解析成左右（量左侧会话栏 `.mP3x-q_sidebarCol` 的 `getBoundingClientRect().width > 40`，量不到就 left）；单槽 + 优先级 `POPOUT_PRIORITY{error:3,pending:2,completed:1}`（`client.js:3395`，高优先抢占、低优先**直接丢弃不排队**）；同会话同类别 10 秒冷却 `POPOUT_COOLDOWN_MS`（`client.js:3396`）；只有会话**首次进入**某类别才触发（`seen` Map 记住上一轮，离开即清）；`displayMs` 由调用方 `setTimeout` 收，回调先比单调 `seq` 再关（旧定时器绝不能关掉新浮层）；`document.hidden` 时不弹，只 log。
- **关闭只有一条路**：`dismiss(exit)` → `kit.close(exit)` → kit 播完退场动画后调 `onDone`；`onDone` 里清 timer、置 `showing=null`。手动点图（`onActivate`）与超时共用这条；点图先 `openSession(showing.sessionId)` 再 `dismiss()`。设置一改就 `settingsChanged()`：开着就关，且**不自动重开**。
- **DOM 契约（验收脚本依赖）**：外壳节点永远带 `data-hotlist-popout` 与 `data-hotlist-popout-cat="<类别>"`，另有 `data-side`（left/right）与 `data-reduce-motion`（0/1）；样式块 `data-hotlist-style="popout"`（`KIT_STYLE_ID`）；`onDone` 之后节点必须真的从 DOM 移除，否则会留一块透明可点区域。挂载根 `document.body`，`z-index:2147483000`。
- **降级**：`display.reduceMotion === 'on'` 或系统 `prefers-reduced-motion` 任一成立 → 入场只走 `--hl-enter-ms:120ms` 的淡入、退场固定 `fade`，粒子不生成。所以 `isReduced` 是「系统 OR 产品」的合并结果，而不是二选一。粒子仍按 `size >= 520` 判定（不是按乘法器）。
- **已知边界**：`popout.entrance` 只读（固定 clip 揭示，设置页显示灰字「固定为探出」）；弹出图出自每类多素材池（v4.2 起），每次事件**随机**取一张（`pickPopoutArt`）。


## 17. 图标定种、弹出图与音效随机

三条取用规则不一样，改的时候别混：

- **图标是身份 → 稳定**：座位 / 侧栏的图标来自 `glyph.uploads[]`，种子是 `"<sessionId>|<category>"`（`resolveStateGlyph`，`client.js:971`；`fnv1a`/`pickIndex`，`client.js:922/932`）。同一会话在同一类别里反复渲染永远是同一张，刷新也不换——**不要**把时间锚塞回种子（v4.2 曾经是 `|<enteredAt>`，结果是每次进类别都换图，真机看到"闪"）。
- **弹出图是事件 → 每次随机**：一次弹层 = 一次事件，`pickPopoutArt`（`client.js:943`）用 `randomIndex` 从 `popout.images[]` 里取；`builtin:true` 时走内置 `assets/<cat>.svg`，池空且非内置才回落 emoji。
- **音效是事件 → 每次随机**：`pickSoundUrl`（`client.js:955`）只在 `pending/error/completed` 三类拼 `/hotlist-sound/<cat>-N.mp3`（`SOUND_CATEGORIES`，`client.js:177`；路由在 host `index.js`）；空池回落内置，其它类别直接返回空串（不制造 404）。

配额与去重：每类每类池上限 `ASSET_POOL_MAX=6`、弹出图 64KB、音效 128KB、图标 16KB、总预算 2MB（`trimAssetBudget`，`client.js:648`，按类别从 sound→popout→glyphSecondary→glyph 的尾部裁剪）。音效另有冷启动首轮只记不播（armed）与 1500ms 全局节流（`SOUND_THROTTLE_MS`），写在 `createSoundPlayer`（`client.js:3606`）。
