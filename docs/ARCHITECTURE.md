# 热表架构（维护者文档）

目标读者：下一个要改这份代码的人。看完应该能回答三件事——状态从哪来、三种显示位置各自怎么挂、哪些地方看起来"脏"但**换干净写法会更糟**。

所有行号对 `client.js`（4782 行，v4.6.5）。**行号是起点不是真理**：文件一改就漂，按符号名搜（`grep -n 'function classify' client.js`）才准。全文 `client.js:N` 引用已在 v4.6.5 对 4782 行版本整体重映射并用脚本逐条校验（定义行直接对符号取真值，区间按旧跨度平移），仍未自动确认的 15 条已人工核对；`test:N` 的 64 条按测试名逐条对齐。

## 1. 分层与真实名字

```
                 ┌────────────────────────────────────────┐
数据源  ────────►│ 纯判定层（无 DOM，可单测）             │
sessions.list    │ sanitizeSettings        client.js:867  │
uiSession.       │ classify                client.js:1590 │
  sessionStatus  │ sortSeats               client.js:1654 │
workspaces.list  │ buildSeatPlan           client.js:1677 │
api-session/error│ sidebarStateOf          client.js:1951 │
                 │ findRowTitle            client.js:1931 │
                 │ shortenTitle            client.js:1530 │
                 │ labelOf                 client.js:1720 │
                 └───────────┬────────────────────────────┘
                            │ plan / row 判定
        ┌───────────────────┼────────────────────────┐
        ▼                   ▼                        ▼
  tab 座位适配器        侧栏 glyph 适配器         设置页
  mountTabSeats         createSidebarAdapter      HotlistSettingsPage
  client.js:4291        client.js:1974             client.js:2668
  disposeTabSeats       start/refresh/stop/misses
  client.js:4331
```

**与任务书用词的差异（别按旧名字找函数）**：代码里没有 `buildMarkerPlan()`、`createTabSeatsAdapter()`。

- 判定拆成两步纯函数：`classify()` 判类别与 token，`sortSeats()` 同级排序，`buildSeatPlan()` 再套上限并给出 `order`。三步都不碰 DOM，可以单独喂假数据测。
- tab 适配器不是独立工厂，而是 `apply()` 内的 `mountTabSeats()` / `disposeTabSeats()`；它需要一个活着的 `ctx`（注册 slot、读写 store），抽成工厂反而要传一堆依赖。
- 侧栏适配器是真正的工厂 `createSidebarAdapter(options)`，接口为 `start() / refresh() / stop() / misses()`（不是 `mount/update/dispose`）。它自己遍历宿主 DOM，不接收 plan——因为一行一行读宿主更简单，而 tab 必须先把 plan 算好再看能放几个。

新增一个显示位置时，照 `createSidebarAdapter` 的形状写一个工厂：**只读 store、只写自己的节点、提供 `stop()` 全量还原、带 `misses()` 自检**，然后像 `sync()`（`client.js:4434`）那样由位置开关驱动 start/stop。不要改 `classify`/`buildSeatPlan`/`sidebarStateOf`。

## 2. 数据源（唯一权威，全部只读）

| 来源 | 取法与语义 | 官方依据 |
| --- | --- | --- |
| `ctx.get('sessions').list.getSnapshot()` | `{ids, byId, phase, projectionsBySession}`。`byId[id]` = `{id, displayTitle, running, retainedBy, blank, updatedAt, formatStatus, projectionValues, title?, cwd?, parentId?, origin?}` | `dsh-api-session-controller/lib/client.js:3830-3835`，字段 `:4169-4182`，子代理补行 `:4192-4235` |
| `updatedAt` | 最近活动（ms），= `max(summary.updatedAt, lastPromptAt)`；**子代理行恒 0** | `:3610` |
| `projectionsBySession[id].values.subagentCatalog` | 子代理清单；子会话在 `sessionStatus` 里 running 就算父会话"在干活"（`mode === 'external'` 的行跳过） | `runningChildren()`，`client.js:1561`；跳外部的 `:4185` |
| `ctx.get('uiSession').sessionStatus.getSnapshot()` | `Map<id, {running, pendingInteraction:{kind}|null, completionUnread}>`；唯一的状态权威 | `dsh-client-ui-session/lib/client.js:782-790`，快照 `:999-1004`，`completionUnread` 置/清 `:964-981` |
| `ctx.get('uiWorkspace').workspaces.list.getSnapshot()` | `{items:[{workspaceId, sessionIds,…}], pinnedSessionIds, archivedSessionIds}`；用于"只列当前工作区"、置顶与归档 | `dsh-client-ui-workspace/lib/client.js:1553` |
| 当前会话 | `byId[*].retainedBy.mainView > 0`（不读 `selection`，避免和持久化快照时序打架） | 侧栏同一规则 `dsh-client-ui-workspace/lib/client.js:877-879`（`mainSessionId`）；热表读法 `client.js:4362` |
| 运行失败 | `ctx.remote.$on('api-session/error', (sessionId, message))`（live-only）+ 已打开会话 `sessions.binding(id)?.session.getSnapshot()` 的 `promptError.error.message` / `lastAgentError` | relay `dsh-api-session-controller:4294`，快照 `:2913-2937`，`promptError` 形状 `:2372-2375` |
| 切会话 | `ctx.get('uiWorkspace').openSession(sessionId)` | `dsh-client-ui-workspace/lib/client.js:1473-1475`，热表封装 `client.js:3901` |

`pendingInteraction.kind` 只有三种：`approval` / `question` / `plan-review`（审批 `dsh-client-ui-approval/lib/client.js:225`，提问与计划审批 `dsh-client-ui-user-questions/lib/client.js:185`：`this.kind = planReviewOf(questions) === void 0 ? "question" : "plan-review"`）。没有独立的 `subagents` 信号，v4 把"子代理在跑"并进 `running`。

## 3. 座位 id、`heal`、`repair` —— 三件互相配套的事

- 座位是 `conversation.view` 的一条注册，id 为 `hotlist-seat-<sid>`（`SEAT_PREFIX`，`client.js:84`；历史前缀 `seat-` 见 `SEAT_PREFIXES`，`client.js:86`）。
- **为什么必须是前缀 id**：宿主把"每个会话当前选中的 view id"持久化进 `localStorage['dsh.conversation.<sessionId>']`（`dsh-client-ui-conversation:4560-4571`）。如果座位 id 就是裸 sessionId，用户点一次座位，源会话的偏好被写成"我的座位页"；座位注销后该 view 不存在，宿主 `resolveActiveView`/`restoreView` 互相激活 → React #185（Maximum update depth）直到人肉清 localStorage。真机事故记录：`cangku/261111_cr8_react185_crash.png`。
- `healViewPreferences()`（`client.js:1757`）在模块加载时扫所有 `dsh.conversation.*`，把指向 `hotlist-seat-*` / `seat-*` / `session-switcher` / `hotlist` 的偏好改回 `chat`（`isSeatViewId`，`client.js:1600`），其它字段原样保留。它是在模块顶层直接调用的（`client.js:1752`），不是 effect。
- `repairSourcePreference()`（`client.js:1778`）补一个更细的竞态：宿主会在我们 `openSession(target)` 之前先写源会话偏好，所以"离开时 activate chat"仍可能被覆盖；在 `settle()` 的开头、250ms、1200ms 三处再修一次源会话的偏好（`client.js:4164-4181`）。**这是补偿宿主时序，不是绕过 API**（没有"设置某会话 view"的公开 API）。

## 4. 座位顺序：类别 order + 类内序号

- v3 的"tier + 进入戳"已随 v4 判定层一起删掉。现在顺序完全由设置决定：跨类别按 `categories[<id>].order` 升序（`orderedCategories()`，`client.js:1537`；同 order 时按 `CATEGORY_RANK` 兜底稳定，`client.js:1543`），类内按 `sortBy` 排（`sortSeats()`，`client.js:1541`）：`time` = `updatedAt` 倒序，`manual` = 按 `pinLevel`（只 `pinned` 用它，`pinLevel` 是判定时现算的 `pinIndex + 1`，`client.js:1631`）。
- 座位 `order = categories[<id>].order * 100 + 类内序号 + 1`（`client.js:1703`）。因此**只要一个座位没换类别、且前面没人增删，它的 order 就不变**——宿主不会因为 30s 的 `sync()` 重排而抖动。
- **不要把 `updatedAt` 直接映射成 order**：宿主每次注册/注销都会 `ctx.emit('slots/changed')`（`dsh-client-ui-renderer:1349-1351`）→ conversation 的 `refreshViews` 遍历所有 binding 做 `restoreView`（`:22633-22660`）。频繁重排 → 反复注销/重注册 → 每次都有机会把某个刚释放的 session 喂进 `binding()`，抛 `uiConversation.binding: unknown session`，并且 active view 会短暂落回 chat。`updatedAt` 只用于类内 `sortBy:'time'` 的排序键；同一批里并列时用 `sessionId` 兜底，保证两次计算结果一致。
- 用户在设置里改某类的 `order`，该类所有座位会一次性换 base（一次重注册），这是预期代价。
- **三层语义在 tab 面上仍然成立**：tier1 = `error` / `pending`（等你处理）+ `pinned` + `completed`（刚刚产出），tier2 = `running`，tier3 = `idle`（最后活动在全局「最近对话展示时间」内的普通会话，`collect.recentWindowMinutes`）。因此 `CATEGORY_SURFACES.idle.tab` 默认是 **true**（`client.js:174`）——用户原话是"五分钟内的会话都加入到那个列表，位于第3级"，把第三级从 tab 面默认关掉等于删掉他明确要的东西。想降噪的用户可以只关 `idle.surfaces.tab`（侧栏保留），这是**可选**手段，不能当默认。

## 5. 上限：物理宽度 ∩ `maxSeats`，紧急类另有硬顶

官方规则：可见 tab 数 = `max(1, floor((rowWidth - 48) / 120))`，超出折叠进一个**点不到**的溢出菜单（`dsh-client-ui-conversation:20814-20831`）。所以上限必须自己算（`seatLimit()`，`client.js:4123`）：

1. 量 `[data-conversation-tabs]` 的**父元素**（`div.an3WzG_tabs`）。tablist 自己是内容宽（实测恒 204px），量它必得 1。
2. `visible = max(1, floor((width - TAB_ROW_PADDING) / TAB_WIDTH))`，常量 `TAB_WIDTH`/`TAB_ROW_PADDING`（`client.js:95-96`）。
3. 给 chat + trajectory 留 2 个位置，返回 `max(1, visible - 2)`。
4. 量不到（0）时回退 6（`FALLBACK_LIMIT`，`client.js:94`）。
5. 最终上限 = `min(settings.maxSeats, seatLimit())`，`maxSeats === 'auto'` 时取 `seatLimit()`（`client.js:4028-4123`）。

`buildSeatPlan()` 的裁剪（`client.js:1564-1604`）：`pinned` / `pending` / `error` 是"要人处理"的类别，**不按 `limit` 裁**，但受硬顶 `limit + ALWAYS_OVERFLOW`（= `limit + 4`，常量 `ALWAYS_OVERFLOW` `client.js:203`）约束；`pinned` 另外受用户自己的 `pinned.maxSeats` 限制（`client.js:1569`）；其余类别（`completed` / `running` / `idle`）填到 `limit` 为止。被裁掉多少记在 `plan.overflow`（`client.js:1693,1602`；v4.4 起设置页不再显示这个数字，字段仍在）。宁可挤一点，也不把要人处理的会话藏起来；但 10 个待审全出座位会把 tab 行挤爆，所以硬顶必须有。

除了上面这套跟用户设置挂钩的规则，还有一刀**与设置无关的绝对硬闸** `PLAN_MAX_ROWS = 37`（`client.js:201`）：plan 排好之后统一 `kept.slice(0, PLAN_MAX_ROWS)`（`client.js:1694`）。取值的理由写在常量注释里（`client.js:199-200`）：「Hard ceiling 37: the plan is sorted by priority, so the tail is exactly what a crowded workspace should lose」。注意 `plan.overflow` 记的是**被上面那些规则挡掉**的条数（`client.js:1586`），不含这 37 条这一刀——两者别混。

## 6. 刷新与订阅的分工

| 触发 | 频率 | 干什么 | 位置 |
| --- | --- | --- | --- |
| `sessions.list.subscribe(sync)` | 数据变即触发 | 会话增删、标题、updatedAt | `client.js:4579` |
| `uiSession.sessionStatus.subscribe(sync)` | 数据变即触发 | 三状态字段变化 | `client.js:4580` |
| `workspaces.list.subscribe(sync)` | 数据变即触发 | 工作区归属、归档、置顶 | `client.js:4581` |
| `setInterval(sync, 30s)` | 30s | `collect.recentWindowMinutes` 滑出窗口、`collect.completedTtlMs` 过期、失败标记过期 | `REFRESH_MS` `client.js:4440`，定时器 `client.js:91` |
| `window resize`（防抖 200ms） | — | 重算 `seatLimit()` | `seatLimit` `client.js:3426`，监听 `client.js:4129-4134`（`RESIZE_DEBOUNCE_MS` `client.js:92`） |
| `onSettingsChange` | 写入即触发 | 座位与图标立刻反映设置页 | `client.js:1406`，effect `client.js:4513-4518` |
| 侧栏内部 1s tick / 30s 全量刷新 | — | `document.hidden` 暂停动效；缓慢兜底 DOM 抖动 | `SIDEBAR_TICK_MS`/`SIDEBAR_REFRESH_MS` `client.js:1841`/`client.js:1845` |

`sync()` 是唯一的收敛点（`client.js:4434`）：读快照 → 记完成态 → 清失败标记 → 读设置 → 按位置开关 start/stop → 算 plan → 挂座位 → 刷侧栏。不要在别处直接改座位。

### 6.1 短读保护（shrink guard）与座位记忆

真机 bug：切换后约 70 秒座位从 5 掉到 2 且不回来——宿主的列表快照短时间缺行。处理（`client.js:4385-4395`、`restoreRecentSeats` `client.js:4391`）：

- 只有"已注册座位的会话从 `list.ids` 消失"才算真的要撤；先记 250ms（`SHRINK_CONFIRM_MS`，`client.js:101`）后二读，两次都缺才撤。
- 撤下的座位进 `recentSeats`：60 秒内（`RECENT_SEAT_MS`，`client.js:103`）会话回来，用**原来的 order/label** 直接恢复，不必重新排队。
- 由我们自己的规则导致的撤座（当前会话、掉出窗口、`maxSeats`、类别 `surfaces` 关、工作区、归档）仍然立即撤。

## 7. `takeOverStatusDot` 为什么是两层

另一插件（dsm）的状态点不在我们的 slot 里，也没有"禁用某插件"的 API。所以：

1. **CSS 层**：只在开关打开时注入 `<style data-hotlist-style="takeover">`（`TAKEOVER_STYLE`，`client.js:1896`；注入/移除 `ensureTakeover`，`client.js:1904`）。
2. **inline 兜底**：如果点仍可见（对方的 MutationObserver 重建、或 CSS 被覆盖），对点写 `display:none!important` 并记下原值；关开关时先移除 style 再逐点回填原 inline 值（`restoreDots`，`client.js:2044`）——**不删对方节点、不卸载对方插件**。

同理 `hideNativeDot` 不写 inline，而是给行加 `data-hotlist-hide-native` 属性（`client.js:2234-2235`），由我们自己的样式表隐藏 `[data-state]` 本体（`SIDEBAR_STYLE`，`client.js:1865`，规则在 `:1771`）；卸载时删属性即还原。

拼接选择器时**只用 `ROW_SELECTOR` 常量原样插入**（它自带方括号）。曾经写成 `[${ROW_SELECTOR}]` → 生成 `[[…]]`，浏览器整条丢弃，两个开关同时失效（v3.0 真机 bug）。测试里有一条断言扫描所有 style 文本不含 `[[`。

## 8. 侧栏 DOM 增强的边界

- 只插入一个 `span[data-hotlist-glyph]` 到**标题 span 之前**（`findRowTitle`，`client.js:1925`：`_title` 类名 → 文本等于 `displayTitle` → 非时间文本 → 第二个 span；找不到就只动图标并 debug 一行，绝不抛）。
- 我们自己的节点**绝不带 `data-state`**，也不放文本节点（emoji 用 `::before{content:attr(data-hotlist-char)}`，方图用 `<img alt="">`），避免被宿主的选择器或无障碍树误认。
- `motionTarget:'row'` 时对**宿主标题**写 inline `animation`（同 keyframes、同相位），停用/换状态/卸载时还原原值（`applyMotion`，`client.js:2174`）。文字动效只许 `opacity`/`translate`，禁 `scale`（字会糊）。
- `MAX_MISSES=60`（`client.js:1845`）：连续找不到行/标题就整块停用（删自己的节点与样式），30 秒后再试，避免在 DOM 大改后继续乱贴。
- **tab label 是字符串管线**：`dsh-client-ui-conversation:20767-20776` 用 `{label}` 画文本，所以 tab 上只有 emoji，不能放图片（图片只能进我们自己的 React 树：设置页预览、未来的顶栏/浮层）。

## 9. 注销为什么延迟

注册/注销都会触发宿主的同步刷新链（见 §4）。会话**离开集合**时：

- 不立即 dispose：`scheduleDisposals()`（`client.js:4258`）= `setTimeout(0)` → `requestAnimationFrame` → `setTimeout(0)` 才真正卸载，让宿主先跑完自己的 unmount 清理。
- 同一个 id 要重建时**同步**先 dispose 旧句柄（否则 duplicate id）；插件卸载/`disposeTabSeats()` 也同步 flush（`flushDisposals`，`client.js:4239`）。
- 收益：真机上我们自己不再成片刷屏。**这是缓解竞态，不是修复宿主**——注释里已写明。
- **宿主自己会抛一次，别去兜**：座位指向的会话被点进去之后用户拒绝审批 / 会话结束，宿主 `refreshViews` 会在会话释放后抛 `Uncaught Error: uiConversation.binding: unknown session "<id>"`（真机 4 次拒绝各 1 条；栈 `UiConversation.binding → activateView → restoreView → refreshViews → OI.flush`，`dsh-api-session-controller/lib/client.js:4067-4074` 的 borrow 语义）。触发条件是「会话已释放、宿主还没清自己的座位表」。**不要加 `window.onerror` 全局吞**：它会盖掉我们以后真出的错，而且这个异常不在我们的调用栈里。我们只负责延后注销 + `phase === 'ready'` 闸门。

## 10. 设置模型与版本

- 形状（`defaultSettings()`，`client.js:300-316`）：`version / maxSeats / positions{tab,topbar,sidebar} / takeOverStatusDot / hideNativeDot / display{reduceMotion} / shortcuts{jumpEnabled,overlayEnabled,overlayKey} / overlay{side,sizeMin,sizeMax,fallbackImage} / collect{completedTtlMs,recentWindowMinutes} / sound{volume} / pinned{maxSeats} / categories{6 类 × 8 字段}`。
  - `pins{<sid>:level}` **已废弃但读时兼容**：v4.6 起置顶改读宿主的 `workspaces.list.pinnedSessionIds`（`pinnedIdsOf()`，`client.js:4347-4350`），手写 pin 表不再使用（注释「v4.6 dropped the hand-written pin list」，`client.js:927`）；旧表仍在已知路径表里被读取接受、随即忽略（`client.js:1143`），不会当成"未知字段"反复搬进 preserved 层。
  - 新增 `pinned{maxSeats}`：置顶座位另有自己的上限（`PINNED_SEATS`，`client.js:198`；设置页行 `data-hotlist-row="pinned.maxSeats"`，`client.js:3040`）。
- 每类字段（`defaultCategory()`，`client.js:246-269`）：`enabled / order / sortBy / surfaces{tab,sidebar,topbar} / glyph{kind,value,source,motion,motionTarget,frequency,uploads[]} / glyphSecondary（只有 pending 有值：❓ + blink） / popout{enabled,builtin,images[],displayMs,entrance,ambient,exit,side} / sound{enabled,builtin,uploads[]}` —— **8 个顶层键**。v4.6 删掉了 `reserved` / `pinLevel` / `within` 三个字段：类别不再有"保留位"概念（`favorite` 整类删除，见 `RETIRED_PATHS`，`client.js:138`），`pinLevel` 改成判定时现算（`classify()` 里 `pinIndex + 1`，`client.js:1631`），`within` 早在 v4.4 就搬成全局 `collect.recentWindowMinutes`。`glyph.frequency` 是 0–1（`motionIntervalMs` 读时换算），`glyph.size` 读时忽略。音效音量是**全局** `sound.volume`，类别里只剩开关与素材池。
- `SETTINGS_VERSION = 4`（`client.js:112`；`107` 现在是 `PRESERVED_KEY`）。v4.1 只改字段形状、没有升版本号（旧记录经 `sanitizeSettings` 逐字段回落即可）：`display.motionWhenNativeVisible` / `display.maxAnimated` / `overlay.scale` 已删，新增 `glyph.source`、`glyph.motionIntervalMs`、`overlay.sizeMin/sizeMax`、顶层 `sound.volume`。v4.4 同样没升版本号：`glyph.motionIntervalMs` → `glyph.frequency`（0–1）、每类 `within` → 全局 `collect.recentWindowMinutes`、`glyph.size` 读时忽略、`settings.overflow` 提示通道删除；旧 `motionIntervalMs` 仍按 `f = 1 − (ms − 2000) / 58000` 单调换算，`0` 依旧表示「不播」。同理 v3 的 `overlay.scale` 倍数在迁移里直接丢弃（只读 `overlay['scale']` 做兼容分支已删），尺寸回落到 260/520。v4.6 也没升版本号：删一个类别、删三个类字段、加 `pinned.maxSeats`，同样靠 `sanitizeSettings` 回落 + `RETIRED_PATHS` 丢弃。
- 迁移链：
  - **v1（2.x，「会话 tab」时代）**：`{completedTtlMs, maxSeats}`，键 `dsh.session-switcher.settings`（`LEGACY_SETTINGS_KEY`，`client.js:111`）。
  - **v2（2.5 更名「热表」）**：同形状，新键（`SETTINGS_KEY`，`client.js:105`）；读旧键后写新键并删旧键。
  - **v3（3.0 / 3.1）**：`states.<state>.{kind,value,motion,motionTarget,follow,reserved}`、`positions` 三布尔、`display`，删 `placement`。
  - **v4（4.0 / 4.1）**：8 个 `states` 收成 7 个 `categories`，新增 `pins`/`collect`/`sortBy`/`within`/`glyph.size`/`popout`/`sound`/`surfaces`；`overlay.enabled` 分发到各类 `popout.enabled`；`maxSeats` 上限 20 → 12。4.1 / 4.4 / 4.6 也都在同一版本号内换形状（见上）。
- 迁移实现：`migrateSettings()`（`client.js:992-1001`）。`version === SETTINGS_VERSION` 走 `sanitizeSettings`；**其它任何版本一律按 v3 表迁移**（`migrateFromV3`，`client.js:945`），因为用户真实数据只有 v3 一种形态。曾经的 alpha 工件把 `version: 5` 写在 v4 形状上，所以迁移里额外把 `categories/collect/pinned` 三张表浅合并过去（`client.js:997-999`）——这不是一条迁移链，只是兼容那个中间态；4→5 那种"只改版本号"的幽灵迁移已删。
- `sanitizeSettings()`（`client.js:867`）是纯函数，从默认值起算，逐字段独立回落：非法值只回落该项，不整份作废。类别级同理 `sanitizeCategory()`（`client.js:788`）。**没有"用户改不动"的保留类别**：`favorite` 是历史类别，v4.6 整类删除并记进 `RETIRED_PATHS`（`client.js:138`），读旧记录时直接丢弃、不再保留成"未来字段"（`collectUnknown` 的短路，`client.js:1215`）。
- 旧键只读兼容：`states` / 扁平 `glyphs` / `motion` / `showIdle` / 顶层 `completedTtlMs` / 旧 `overlay.*`。写入侧由 `upgradePatch()`（`client.js:1409`）把旧键映射回 v4 字段，再 `mergePatch()`（`client.js:1458`）逐类合并；读取侧不再有 v3 投影（设置页已经直接读 v4）。
- 对外 API：`window.__HOTLIST_SETTINGS__`（`client.js:1807`，旧名 `__SESSION_SWITCHER_SETTINGS__` 同对象 `client.js:1808`）。方法集是 `get / set / reset / subscribe / override / defaults / glyphOf / emojiOf / lastError`（`client.js:1795-1806`）——**有 `defaults`，没有 `backups/restore`**；备份环只在 `window.__HOTLIST__.settings.backups()/restore(i)` 上（见 §10.2）。`override()` 是测试缝（注入内存 patch），生产不要用。
- 同页写入靠 `notify()`（`client.js:1390`）广播；`watchStorage()`（`client.js:1505`）只负责**跨窗口**（`storage` 事件同页不触发）。

### 10.1 "用户设置永不覆盖"：preserved 层

用户在更新版本里"凭空消失"的选择必须能回来，所以任何一次写盘之前都先把**当前实现表达不了的东西**存到独立的保留键（`PRESERVED_KEY`，`client.js:107`）：

- `notePreserved(previous)`（`client.js:1280-1289`）= `collectUnknown(previous)` ∪ `outOfRangeOf(previous)`，非空才写。`collectUnknown`（`client.js:1209-1230`）走 schema 的已知叶子/容器表，`RETIRED_PATHS` 里的路径直接跳过（`:1121`）；`outOfRangeOf`（`client.js:1233-1262`）把被边界拒掉的数字连同 `{raw, clamped}` 一起留下。
- 读回用 `revivePreserved()`（`client.js:1324-1327`）= `reviveOutOfRange(reviveUnknown(...))`。两条复活判据都很保守：`reviveUnknown` 只在**当前值仍等于默认值**（= 用户没选过，`client.js:1314`）时才写回；`reviveOutOfRange` 只在**当前值仍等于当初被夹到的 `clamped`**（= 用户没改过，`client.js:1298`）且原始值已落在放宽后的范围内时才写回。
- `writePreserved` 自己吞 quota 异常（`client.js:1271-1277`）：注释写明「a full quota costs the preserved copy, never the live settings」。
- 顺序很关键：`persist()`（`client.js:1346-1356`）= 先 `pushBackup(previous)` → 再写 `SETTINGS_KEY` → **写成功才** `notePreserved(previous)`。写失败时 `lastWriteError` 记 `'quota'`（`QuotaExceededError`）或 `'storage'`，设置页据此提示（`client.js:3090`），并且这一轮不做保留。

### 10.2 备份环

`pushBackup(previous)`（`client.js:1335-1339`）把**上一份完整设置**塞进环形数组 `[{at, settings}, …].slice(0, BACKUP_LIMIT)`（`BACKUP_LIMIT = 5`，`client.js:110`，键 `BACKUP_KEY` `client.js:109`）。所以每次写盘都自动留一手，最多 5 步可回退。`readBackups()`（`client.js:1329-1333`）过滤坏项。对外只有 `window.__HOTLIST__` 暴露：

- `settings.backups()` → `[{at, version}]`（`client.js:3922`，不返回内容）
- `settings.restore(index)` → `sanitizeSettings(entry.settings)` → `persist` → `notify()`（`client.js:3924-3931`），失败返回 `warning`

`settings` 的其余方法是 `get / set / reset / subscribe`（`client.js:3815-3818`）——**没有 `defaults`**。

### 10.3 出厂预设不是用户选择（`LEGACY_VALUES`，v4.6.4）

§10.1/§10.2 管的是「实现暂时表达不了的值」和「写坏了的整份记录」；它们都不处理另一种情况：**盘上的值是我们自己某一代发的默认值，用户从来没动过**。这种值不该被当成用户选择——否则我们改默认参数（v4.6.3 把闲置图标换成 `🧊`、动效表整体重排）对老安装永远不生效，用户只能自己去设置页重设一遍。

分界线：**存值恰好等于某一代出厂预设 → 跟随当前默认；否则是用户选择，一字不动**（用户 `m08181` 原话：「如果老用户未变更的情况下 我们应该更新成新的 因为那不是老用户的自定义，那是属于我们的预设」）。表在 `LEGACY_VALUES`（`client.js:152-159`），第一列是 v4.3.0 那一代：`glyph.value: ['💤']`、`glyph.motion: ['none','blink']`、`glyph.motionTarget: ['glyph']`、`glyph.frequency: [1]`、`glyphSecondary.motion: ['blink']`、`sound.enabled: [false]`。逐字段查表走 `legacyValuesOf(sub, key)` / `isLegacyValue()`（`client.js:692-700`）——`sub` 是 `'glyph'` / `'glyphSecondary'` / `'sound'`，两个 glyph 槽各有自己的表，不串味。

三条实现要点，改这块之前先看：

- **闸门要盖住 `own.value`，不只是 legacy 的 `oldEmoji`**（`client.js:759-765`）。v4 记录里 emoji 存在 `own.value`，💤 就在那里；只让 `oldEmoji` 过闸门则 v4.6.4 的目标根本不生效。
- **`sound.enabled` 别写反**（`client.js:849-850`）：`next.sound.enabled` 此刻已经是当前默认，所以命中旧默认 `false` 时保留 `next`（而不是保留存值）。
- **与 order 的 `LEGACY_DEFAULTS`（`client.js:132-137`）同一条规则、两套表**：那边是「命中就用 `CATEGORY_ORDER`」，这里是逐字段回落，语义一致所以没合并。

它和另外两层是互补的，不是重复：`outOfRangeOf`/`reviveOutOfRange` 救「被夹掉的值」，`collectUnknown`/`reviveUnknown` 救「当前 schema 不认识的字段」，`LEGACY_VALUES` 管「认识、合法、但等于老默认」。三条都对同一个 `sanitizeSettings` 起作用，顺序是「回落（含 `LEGACY_VALUES` 让位）→ 读 preserved → 复活」。

### 10.4 「用户真选过吗」：`choices` 标记（v4.6.5）

§10.3 只看**值**：等于老默认就当预设。这会把控件砸死——用户在设置页里主动选 `none` / `blink` / 「仅图标」/ 频率 100% / 关音效，这些**恰好就是旧默认值**，选完立刻被闸门改回去（界面回弹）。v4.6.5 加一层显式标记：

- `settings.choices = { "categories.<类别>.<槽>.<字段>": true }`，默认 `{}`（`defaultSettings()` `client.js:306`）。只有**用户自己写过**的字段在里面。
- 埋点在唯一写入口 `writeSettings(patch)`（`client.js:1491`）：先 `choicesFromPatch(upgraded, base)`（`client.js:719-737`）再 `mergePatch`。**必须看传进来的 patch，不能看合并后的整体**——预设规则在 sanitize 阶段改写值，被它改写的不算选择。
- 闸门是 `旧预设 && choices[path] !== true`：`sanitizeGlyph` 四处（`client.js:759-790`）与 `sanitizeCategory` 的 `sound.enabled`（`client.js:844-855`）；`sub`/`category` 都在手边，路径直接拼。
- 清洗走 `sanitizeChoices()`（`client.js:702`）：只留 `true`、只认 `/^categories\.[a-z]+\.[a-zA-Z]+(\.[a-zA-Z]+)?$/`、键长 ≤80、上限 256；它是 `knownLeaves`（`client.js:1147`）里的叶子，所以不会掉进 preserved 副本。
- `resetSettings()`（`client.js:1502`）连 `choices` 一起清空：恢复默认 = 重新认可出厂预设，之后新版预设又能覆盖。
- **不升 `SETTINGS_VERSION`、没有迁移**：缺字段补 `{}` 即可；老记录没有标记，语义仍等于「全是预设」，与 §10.3 完全一致。

配套的必要改动：`mergePatch` 对 `categories.<id>.<字段>` 多合一层（`client.js:1464`）。以前设置页必须把整个 `glyph` 对象摊平进 patch（否则上传池被冲掉），那样 `hasOwnProperty` 会看到四个键全在，等于每次编辑把所有字段都标成选择；现在 patch 只带真正改动的键，`{glyph: {motion}}` 不碰 `uploads`。

## 11. 扩展点

**加一个类别**：`CATEGORY_IDS`/`CATEGORY_ORDER`/`CATEGORY_RANK`（`client.js:122-125`）、`CATEGORY_GLYPHS`（`client.js:141`）、`CATEGORY_MOTION`（`client.js:142`）、`CATEGORY_SURFACES`（`client.js:144`）、`CATEGORY_OF_TOKEN`（`client.js:244`）、`classify()` 的判定分支（`client.js:1590`）、`sidebarStateOf`（`client.js:1951`）、`buildSeatPlan` 的 `always` 集（`client.js:1675`）、ZH/EN 字典（`ZH` `client.js:332`、`EN` `client.js:456`）、设置页卡片循环（`client.js:3073-3075`）；再加单测。加类别时记得 `CATEGORY_RANK` 要给同级 order 一个稳定的兜底位次。

**加一个显示位置**：`defaultSettings().positions` 加键（`client.js:329`）、`positionsOf`（`client.js:319-330`）加派生、`sanitizeSettings` 里保留布尔（`client.js:869-874`）、写一个适配器工厂并让 `sync()` 开关它（`client.js:4434-4504`）、设置页加卡片。不要动 plan。

**改快捷键**：已接线，实现在 `ctx.inject(['shortcuts'], …)` 块里（`client.js:4597`）。**不要**自己 `window.addEventListener('keydown')`——官方有 `ctx.shortcuts`（`@deepseek-ai/dsh-client-shortcuts`）：`register`（可被用户改键）/ `registerFixed`（固键）/ `observeFixedInput`（自己分派），都返回幂等 disposer，用 `ctx.effect` 交给 Cordis 回收。注意 `Alt+1..9` 在 web 端被 `isWebBindingAllowed` 拒（裸 Alt+数字），第三方 `dsh-session-hotkeys` 又会在 capture 阶段抢键；`Alt+Shift+[` / `]` 与 `Alt+Shift+S` 可行。`registerFixed` 只负责显示（它不做 region/modal/repeat 过滤），所以全部守卫写在 `observeFixedInput` 里：`gesture.repeat/composing/defaultPrevented/control/meta` 任一成立就放行原事件；`context.region !== 'page'` 让位给输入框；`context.modal !== null` 让位给菜单/对话框（`modalSelector` 含 `role=menu`）；两条都过了才 `input.consume()`。`S` 还要求 `shortcuts.overlayEnabled === true`（默认关）。

**暴露成客户端服务**（让别的插件 `ctx.get('hotlist')`）：本插件目前**没有** provide 任何 Cordis 服务；官方服务的写法是 `class X extends Service { constructor(ctx){ super(ctx,'uiWorkspace') } }`（`dsh-client-ui-workspace/lib/client.js:1361/1382`）。照此加一个 `Service` 子类并在 `apply()` 里实例化即可；建议只暴露只读的 `classify`/`snapshot()`，不要暴露 adapters。

## 12. 版本与标记（验收脚本依赖）

- `VERSION`（`client.js:82`）→ `window.__HOTLIST_VERSION__`（`client.js:3968`，旧名别名 `client.js:3969`）、座位 body 的 `data-hotlist-seat` / `data-hotlist-version`（`client.js:4217-4218`）、设置页根 `data-hotlist-settings="v4.6.5"`（`client.js:3086`）。
- 设置页行选择器 `[data-hotlist-row]`；侧栏 marker `span[data-hotlist-glyph]`；我们注入的样式都带 `data-hotlist-style`（`sidebar` / `takeover` / `page`）。浮层 kit 的样式块是唯一例外：`id="hotlist-popout-kit-style"` + `data-hotlist-kit="style"`（`injectKitStyle`，`client.js:3232-3239`），见 §14。

## 13. v4.6 已落地与还没接的行为

设置页是 **6 张**折叠卡（`data-category`，可多开）+ 全局区，紧凑多列排版（真机折叠 44px、展开 514/466px，目标 ≤520px）；浮层已接线（§14）+ 完成时间已落盘（§15）；动效按类抽签（§16）；音效与素材池（v4.2）、两条循环热键（v4.3）都已接上。侧栏与 tab 现在读同一份事实：`refresh()` 把 `readSession` 算好的 `pinned` 与 `children` 一路传进 `sidebarStateOf`（`client.js:4531-4542` 提供，`client.js:2199-2208` 消费），所以置顶会话在侧栏也出 📌、子会话在跑时父会话在侧栏也出 ⏳——v4.4 之前这两个参数在侧栏路径上漏传，两边会对同一会话给出不同状态。

v4.4 是维护批：设置页删掉 `hideNativeDot` / 快捷键 / 恢复默认三块，收录窗口搬成全局「最近对话展示时间」，动效间隔换成 0–100% 的播放频率滑块，预览改成按频率常驻循环，`plan.overflow` 提示条删除（字段仍在）。**注意"删"的是 UI 行**：`hideNativeDot` 与 `shortcuts{jumpEnabled,overlayEnabled,overlayKey}` 字段仍在设置记录里（`client.js:306`、`client.js:315`），`sanitizeSettings` 仍认它们（`client.js:881-899`），`nativeDotVisible` 仍由 `hideNativeDot` 派生（`client.js:333`），侧栏仍照它加 `data-hotlist-hide-native`（`client.js:2240`）。v4.5 再删「弹出图尺寸」一行：`overlay.sizeMin/sizeMax` 字段与 `show()` 取中值的算法都保留，只能走 API；内置音效从「每类 7 条 mp3 随机」改成两个 wav 一对一映射（`pending` / `error` → `attention.wav`，`completed` → `complete.wav`，其它类别没有声音，常量 `BUILTIN_SOUND` 见 `client.js:237`）。

v4.6 是结构批：①类别 7 → 6，`favorite` 整类删除（`RETIRED_PATHS`，`client.js:138`），类别形状同时去掉 `reserved`/`pinLevel`/`within`（§10）；②手写 `pins` 表废弃，改读宿主 `pinnedSessionIds`，并新增 `pinned.maxSeats`；③判定优先级定为 `error > pending > completed > running > pinned > idle`（`classify()` `client.js:1612-1634`，侧栏同序 `client.js:1951-1964`）；④新增"用户设置永不覆盖"的 preserved + backup 两层（§10.1 / §10.2）与 plan 的 37 行绝对硬闸（§5）。

v4.6.4 只补了 §10.3 那一块：出厂预设（`💤` / `blink` / `none` / `motionTarget: 'glyph'` / 频率 `1` / 音效关）不再当成用户选择，老安装因此真正拿到 v4.6.3 的新默认；用户改过的值一个不动。**没有新 UI、没有升 `SETTINGS_VERSION`、没有迁移**。

v4.6.5 只补 §10.4：`choices` 记录用户真正动过的字段，闸门改成「等于旧预设 **且** 没被选过」，于是 `none` / `blink` / 「仅图标」/ 频率 100% / 关音效这些和旧默认同值的选项终于能落地，没动过的字段照旧跟随新预设。**没有新 UI、没有升 `SETTINGS_VERSION`、没有迁移**；4.6.4 未发布，对外是「4.6.3 → 4.6.5」。

仍是「只存值不接行为」的：`shortcuts.jumpEnabled`（`Alt+1–9` 被占用）、`shortcuts.overlayEnabled`（热键照常工作，设置页没有这一行）、`overlay.fallbackImage`（没有 UI）、`surfaces.topbar` / `positions.topbar`（恒 false，等顶栏）、`hideNativeDot`（没有 UI 行，值有效）。

## 15. 「刚完成」为什么要持久化

`✅ completed` 是热表自己算出来的：宿主只把 `completionUnread` 维护 1–3 分钟、打开会话立刻清（`dsh-client-ui-session/lib/client.js:964-981`），不够用。所以热表自己记 `running true→false` 与 `completionUnread false→true` 两个跳变（`observeCompletion`，`client.js:4084`），时间放 `completedAt` Map。

- **拒绝 / 中断也算「完成」**：判定只看 `running true→false`（`observeCompletion`，`client.js:4084`），与「为什么结束」无关。用户拒绝审批导致会话结束时，该会话进 ✅（我们的自记 `completedAt`），**不是** ⛔；⛔ 只覆盖自采的 `api-session/error`（agent 级错误）。语义是对的：用户处理完了，就该从 tier1「等你」掉下来。

**只在内存里放会丢一个真问题**：页面一重载（改设置、刷新、端口重启）所有 ✅ 都变回 idle，用户看到的"刚跑完"列表凭空消失——这正是 v4.1 之前的行为，验收里被判为缺陷。于是：

- 键名常量 `COMPLETED_AT_KEY`（`client.js:2384`），值 `{version, entries: {<sessionId>: <ms>}}`；该常量写成正则字面量并取 `.source` 落盘——预重启闸门会先抹掉字符串再搜键名，写成普通字符串它就看不见（RegExp 直接当 key 用会把两侧斜杠带进 localStorage）。
- 读（`readCompletedAt`，`client.js:1108`）：按 `collect.completedTtlMs` 剪掉过期、丢掉非字符串 id / 非有限时间戳、坏 JSON 整体回落空表，**永不抛**。
- 写（`persistCompletedAt`，`client.js:1121`）：500ms 合并（`COMPLETED_FLUSH_MS`，`client.js:2386`），一批跳变只落一次盘；`forgetFinished(id, true)` 是"用户已经打开这个会话"的路径，**同步落盘**，不能让 ✅ 在盘上多留一秒；插件卸载时 `flushCompletedAt()` 兜底。
- 剪枝还看工作区：`snapshot.workspaceIds` 里没有的 id 一律 `forgetFinished`——别的窗口的完成表不属于这个窗口。
- **列表没拉完就不许剪枝**：`sessions.list` 快照带 `phase`（`dsh-api-session-controller/lib/client.js:2995` 构造时 `'pending'`，`:3283` 首拉 `session.list` 成功才 `'ready'`）。`observeCompletion` 开头 `if (snapshot.list.phase !== 'ready') return;`（`client.js:4091`）——否则 reload 后首轮 sync 拿着"只到了几行"的快照，把刚从盘上读回来的时间戳全判成"会话不存在"删掉。真机日志：1201ms 时 `rowN=8 / tabN=0` 就写回了 `{}`。单测 `completedAt persistence` 覆盖三条：pending 不剪、ready 才剪、当前会话同步删。
- 只持久化 completed。`error` 是 live-only（重连不补发），`idle` 是时间窗口，都不该落盘。

## 16. 动效为什么是"抽签"而不是"常亮"

旧做法是给每个座位加 CSS 无限动画并按 `maxAnimated` 截断，结果是整屏图标一起转、看不出重点。现在：

- 每个类别有自己的 `glyph.frequency`（0–1、步进 0.05、默认按类：置顶 0.3 / 报错 0.9 / 待处理 0.9 / 已完成 1 / 进行中 1 / 闲置 0；1 = 每个节拍都播、0 = 该类永不动）。侧栏适配器仍是 1s ticker，但不再按时间记账：**每个类别每 tick 掷一次**骰子 —— `roll = Math.random()`，`roll >= frequency` 就跳过，命中后用同一个 `roll` 从该类里挑**一个**座位播一遍单程动画（`MOTION_MS{spin:2400,pulse:1600,bounce:1200,blink:1200}`，`client.js:1843`）。所以单测能精确断言「每类每 tick 恰好一次随机调用」；`frequency` 为 0 的类连骰子都不掷。
- 并发上限 `MOTION_CONCURRENCY=4`（`client.js:217`）：四个座位正在动时，后来的类跳过（它已经掷过骰子，只是不再 `startBurst`）。
- `reduceMotion: 'on'` 一次全停且不再掷；`display:hidden` 时 ticker 只切暂停属性；卸载/`stop()` 清掉所有 burst 定时器。
- 动画本身仍是纯 CSS（`hl-spin` 等 + 单程变体 `hl-spin 2.4s linear 1`）。`row` 目标用 `hl-text-*`：只改 `opacity` 与 1–2px 的 `translate`，**不加 `scale`**（文字放大会发虚）。v4.3 之前这里只动 `opacity`，真机上看起来「标题根本没动」，v4.4 加了小位移才看得出；这也是 `motionTarget` 设为 `row` 时一直保留这个选项、没有被藏进 API 的原因。
- 键名 `data-hotlist-burst` 标记"这一轮正在动"，验收脚本与单测都靠它数并发；标题上的 `data-hotlist-text-motion` 标记文字动效。
- **预览**是同一套频率的可视化：`previewStyle()`（`client.js:2414`）在 `previewKeyframes()`（`client.js:2397`）生成的 20 档 `@keyframes hl-pv-<motion>-<step>` 之间选一档（`PREVIEW_STEPS=20`，`client.js:2388`）——`step = round(frequency * 20)`，动画时长按 `20 / step` 拉长，于是「动作时间 ÷ 周期」正好等于频率；`frequency = 0` 时 `glyphNode` 直接不给 animation（`previewStyle` 自身会把 0 夹到 1 档，无法表示"不播"）。它用 `linear infinite` 常驻循环，所以设置页一打开就能看到频率的实际感觉，滚出视口/卸载即随节点消失。

## 14. 浮层（popout）：素材、kit 与调用方分工

素材与 kit 的权威副本都在 cangku（不属于发布物）：设计稿 `cangku/tmp/hotlist-art/popout-kit.js`，接线契约 `cangku/tmp/hotlist-art/v4-popout-integration.md`。进插件的是**内联副本**（`client.js:2993-3462`，kit 段横幅注释在 `client.js:3095-3108`）：`TIERS` / `SCALES` / `KIT_TIMING` / `KIT_CSS` / `mountPopout` 等逐字照抄，只加了一个选项 `isReduced`（产品级 `display.reduceMotion` 推导不出系统偏好，由调用方算完传进来）。改动画常量要两边一起改，并同步 `assets/manifest.json`。

- **素材**：`assets/<category>-<tier>.webp`（`TIERS=[64,320,780,1560]` `client.js:3111`，选档由 `tierFor(cssPx,dpr)` 算）；离线或缺档回落到 `assets/<category>.svg`（`fallbackRef`，`client.js:3171`），再回落 emoji（`KIT_EMOJI`，`client.js:3117`；回落链 `client.js:3355-3373`）。`assetRef`（`client.js:3166`）拼的是 `plugins/@merusu/dsh-better-notice/assets/…`，由 `makeResolveAsset`（`client.js:3571`）区分三种输入：`data:` 原样、`builtin:<cat>` 或空串走内置、其余当 asset id；**任何分支都不抛**。实际加载走模块 loader 的 `require.asset`（`@deepseek-ai/dsh-client-modules/lib/client.js:844`），热表在 popout effect 里注入（`client.js:4563`）。
- **尺寸**：v4.1 起由全局 `overlay.sizeMin/sizeMax` 决定——`show()` 取两者中值传给 kit（`size`），不再有 `overlay.scale` 倍数；`resolvePopoutSide` 决定左右。v4.5 起设置页删掉了「弹出图尺寸」这一行（用户当场否掉这个设置），字段与算法都保留，只能走 API 改。
- **谁决定什么**：kit 只画一只「人」，不管时机。调用方 `createPopoutController`（`client.js:3596`）负责——`resolvePopoutSide`（`client.js:3577`）把 `auto` 解析成左右（量左侧会话栏 `.mP3x-q_sidebarCol` 的 `getBoundingClientRect().width > 40`，量不到就 left）；单槽 + 优先级 `POPOUT_PRIORITY{error:3,pending:2,completed:1}`（`client.js:3589`，高优先抢占、低优先**直接丢弃不排队**）；同会话同类别 10 秒冷却 `POPOUT_COOLDOWN_MS`（`client.js:3590`）；只有会话**首次进入**某类别才触发（`seen` Map 记住上一轮，离开即清）；`displayMs` 由调用方 `setTimeout` 收，回调先比单调 `seq` 再关（旧定时器绝不能关掉新浮层）；`document.hidden` 时不弹，只 log。
- **关闭只有一条路**：`dismiss(exit)` → `kit.close(exit)` → kit 播完退场动画后调 `onDone`；`onDone` 里清 timer、置 `showing=null`。手动点图（`onActivate`）与超时共用这条；点图先 `openSession(showing.sessionId)` 再 `dismiss()`。设置一改就 `settingsChanged()`（`client.js:3767`）：开着就关，且**不自动重开**。
- **DOM 契约（验收脚本依赖）**：外壳节点永远带 `data-hotlist-popout` 与 `data-hotlist-popout-cat="<类别>"`，另有 `data-side`（left/right）与 `data-reduce-motion`（0/1）（写入点 `client.js:3381-3389`，外壳 `client.js:3316-3330`）；图片再带 `data-hotlist-fallback`（`webp`/`svg`/`emoji`）；样式块 `id="hotlist-popout-kit-style"` + `data-hotlist-kit="style"`（`KIT_STYLE_ID`，`client.js:3125`；注入 `injectKitStyle`，`client.js:3130-3137`）；`onDone` 之后节点必须真的从 DOM 移除（`client.js:3546-3554` 连样式一起删），否则会留一块透明可点区域。挂载根 `document.body`，`z-index:2147483000`（`client.js:3184`）。
- **降级**：`display.reduceMotion === 'on'` 或系统 `prefers-reduced-motion` 任一成立 → 入场只走 `--hl-enter-ms:120ms` 的淡入、退场固定 `fade`，粒子不生成。所以 `isReduced` 是「系统 OR 产品」的合并结果，而不是二选一。粒子仍按 `size >= 520` 判定（不是按乘法器）。
- **已知边界**：`popout.entrance` 只读（固定 clip 揭示，设置页显示灰字「固定为探出」）；弹出图出自每类多素材池（v4.2 起），每次事件**随机**取一张（`pickPopoutArt`）。


## 17. 图标定种、弹出图与音效随机

三条取用规则不一样，改的时候别混：

- **图标是身份 → 稳定**：座位 / 侧栏的图标来自 `glyph.uploads[]`，种子是 `"<sessionId>|<category>"`（`resolveStateGlyph`，`client.js:1070`；`fnv1a`/`pickIndex`，`client.js:1020/932`）。同一会话在同一类别里反复渲染永远是同一张，刷新也不换——**不要**把时间锚塞回种子（v4.2 曾经是 `|<enteredAt>`，结果是每次进类别都换图，真机看到"闪"）。
- **弹出图是事件 → 每次随机**：一次弹层 = 一次事件，`pickPopoutArt`（`client.js:1041`）用 `randomIndex` 从 `popout.images[]` 里取；`builtin:true` 时走内置 `assets/<cat>.svg`，池空且非内置才回落 emoji。
- **音效是事件 → 固定映射**：`pickSoundUrl`（`client.js:1054`）在 `pending/error` 返回 `/hotlist-sound/attention.wav`、`completed` 返回 `/hotlist-sound/complete.wav`（映射 `BUILTIN_SOUND`，`client.js:235`；`SOUND_URL` `client.js:234`；路由在 host `index.js`）；空池回落内置，其它类别直接返回空串（不制造 404）。

配额与去重：每类池上限 `ASSET_POOL_MAX=6`（`client.js:197`）、弹出图 64KB（`POPOUT_MAX_BYTES` `client.js:222`）、音效 128KB（`SOUND_MAX_BYTES` `client.js:223`）、图标 16KB（`GLYPH_MAX_BYTES` `client.js:195`）、总预算 2MB（`ASSET_TOTAL_MAX_BYTES` `client.js:225`）（裁剪 `trimAssetBudget`，`client.js:666`，按类别从 sound→popout→glyphSecondary→glyph 的尾部裁剪）。音效另有冷启动首轮只记不播（armed）与 1500ms 全局节流（`SOUND_THROTTLE_MS`，`client.js:239`），写在 `createSoundPlayer`（`client.js:3800`）。
