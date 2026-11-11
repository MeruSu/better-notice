# 热表 / Hot List

把还活着的会话摊在眼前，而不是在侧栏里一列排开、靠时间先后猜哪个在等你。

热表读的是宿主自己的会话状态（`sessions.list` 与 `uiSession.sessionStatus`），不做任何额外采样：

- **对话区 tab 行**：按你排定的类别顺序，给活跃会话各开一个 tab，点一下直接切过去（`client.js:4087`）。
- **左侧会话栏**：在会话标题前放一枚状态图标（emoji 或你上传的方图），可选动效（`client.js:1646`）。
- **速查浮层**：会话**首次进入**某个类别时，从窗口左/右边缘"探出半张脸"一张 260–780px 的状态图（`client.js:3402`）；点它直接切过去，`displayMs` 到点自己收回。同一会话同类 10 秒内不重复弹，`error > pending > completed` 抢占，低优先直接丢弃。

## 七个类别

| 类别 | 判定 | 默认图标 | 默认动效 | 默认顺序 | tab | 侧栏 |
| --- | --- | --- | --- | --- | --- | --- |
| `pinned` | 你在 `pins` 里钉住的会话（`pinLevel` 1–99，越小越前） | 📌 | none | 0（恒最前） | ✅ | ✅ |
| `error` | 本进程收到过该会话的 `api-session/error`，或已打开会话快照里有 `promptError` / `lastAgentError`；10 分钟过期 | ⛔ | bounce | 10 | ✅ | ✅ |
| `pending` | 等待审批（`approval`）、等待回答（`question`）、计划审批（`plan-review`）三者合并 | 🔐（副图标 ❓ 16px） | blink | 20 | ✅ | ✅ |
| `completed` | 本插件看到它跑完，且在 `collect.completedTtlMs` 内 | ✅ | none | 30 | ✅ | ✅ |
| `running` | 正在运行，含"子代理在跑、父会话空闲" | ⏳ | spin | 40 | ✅ | ✅ |
| `idle` | 空闲，且在 `within` 分钟内（默认 5 分钟） | 💤 | none | 50 | ✅ | ✅ |
| `favorite` | 预留（`reserved`、`enabled:false`），当前恒不产出 | ⭐ | none | 60 | ❌ | ❌ |

判定优先级是固定的（一个会话同时"报错 + 待审批"时归 `pending`，因为待审批是唯一能动手的态）：`pinned > pending > error > completed > running > idle`。**展示顺序不是判定优先级**——由每类的 `order` 决定，默认 `error(10) < pending(20)`，与用户看到的"置顶 报错 待审 完成 干活中 闲置"一致。判定在同一条纯函数里（`classify()`，`client.js:1271`），侧栏图标与 tab 标签共用它，不会出现"侧栏显示正在跑、tab 显示已完成"。

`idle` 默认**在 tab 行也出座位**（第三级）：它是"五分钟内的会话都进列表"的落点。嫌吵就只关 `idle.surfaces.tab`（侧栏保留），这是可选降噪，不是默认。

## 可配置项（与 `defaultSettings()` 一一对应，`client.js:243`）

### 全局

| 设置 | 默认值 | 范围 / 说明 | 设置页可改 |
| --- | --- | --- | --- |
| `maxSeats` | `6` | `1`–`12`，或 `'auto'`（跟随 tab 行实际宽度） | ✅ |
| `positions.tab` | `true` | 对话区 tab 行 | ✅ |
| `positions.topbar` | `false` | 窗口顶栏；**未实现**，设置页置灰 | 占位 |
| `positions.sidebar` | `true` | 左侧会话栏图标总开关；这一行已从设置页移走，改由各类 `surfaces.sidebar` 控制 | ⚪ API |
| `takeOverStatusDot` | `true` | 顶掉其它插件（dsm）的状态点；关掉即恢复 | ✅ |
| `hideNativeDot` | `true` | 隐藏宿主自带状态槽（只藏本体，不动无障碍副本） | ✅ |
| `collect.completedTtlMs` | `420000`（7 分钟） | 1–1440 分钟 | ✅ |
| `display.reduceMotion` | `'auto'` | `auto`（跟随系统）/ `on` / `off`；全局行已移走，浮层与侧栏都读它 | ⚪ API |
| `pins` | `{}` | `{ <sessionId>: 级别 }`，级别 1–99，最多 50 条 | ✅（`pinned` 卡内） |
| `shortcuts.jumpEnabled` | `true` | 键盘跳转（灰度开关，恒灰：`Alt+1–9` 被宿主与 `dsh-session-hotkeys` 占用） | ⚪ API |
| `shortcuts.overlayEnabled` | `false` | `Alt+Shift+S` 手动弹一次浮层（不看冷却与「首次进入」） | ✅ |
| `shortcuts.overlayKey` | `'Alt+Shift+S'` | 展示用；处理器按物理键 `KeyS` 判 | ⚪ API |
| `overlay.side` | `'auto'` | `auto` / `left` / `right` | ✅（只存值） |
| `overlay.sizeMin` | `260` | 120–900px：弹出图最小边长（`min>max` 自动交换） | ✅ |
| `overlay.sizeMax` | `520` | 120–900px：弹出图最大边长；实际尺寸取两者中值再按视口收窄 | ✅ |
| `overlay.fallbackImage` | `''` | 空 = 用内置素材；否则 data URL（同 16KB 白名单） | 占位 |
| `sound.volume` | `60` | 0–100 全局音量（真的会响，见「音效」一节） | ✅ | |

### 每个类别（`categories.<id>.*`，7 类各一份）

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | 前 6 类 `true`，`favorite` `false` | 关掉即不判定、不出座位、侧栏不出图标 |
| `order` | 见上表（10…60） | 1–99，`pinned` 强制 0 |
| `sortBy` | `'time'`（`pinned` 为 `'manual'`） | `time` = 最近活动倒序；`manual` = 按 `pins` 的级别 |
| `surfaces.tab` | 除 `favorite` 外都 `true` | 该类在 tab 行出不出座位 |
| `surfaces.sidebar` | 全 `true` | 该类在侧栏出不出图标 |
| `surfaces.topbar` | 全 `false` | 恒 false，等顶栏实现 |
| `glyph.source` | `'emoji'` | `emoji`（文本/内置图标）/ `upload`（上传方图）/ `popout`（用该类别弹出图当图标） |
| `glyph.kind` | `'emoji'` | `emoji` 或 `img`（上传方图） |
| `glyph.value` | 见上表 | emoji 最长 8 个字形；img 为 data URL，单张 ≤16KB，白名单 `png/jpeg/webp/gif`（**拒 svg**） |
| `glyph.motion` | 见上表 | `none` / `spin` / `pulse` / `bounce` / `blink` |
| `glyph.motionTarget` | `'glyph'` | `glyph`（只动图标）/ `row`（图标 + 标题文字；仅侧栏可整行动） |
| `glyph.motionIntervalMs` | `8000` | 该类平均动效间隔：`2000`–`60000`（1000 步进），`0` = 该类不动；到点随机挑一个座位播一遍 |
| `glyph.size` | `20` | 侧栏图标像素边长，吸附到 `16` / `20` / `24` / `32` |
| `glyphSecondary` | 仅 `pending`：❓ 16px | 第二枚小图标（等待审批时同时显示"还要回答"） |
| `within` | `idle` 为 5，其它 0 | 收录窗口（分钟，0–120）；只对 `idle` 有意义 |
| `popout.enabled` | `error` / `pending` / `completed` 为 `true` | 该类别进入时是否弹浮层 |
| `popout.image` | `''` | 空 = `builtin:<id>` 内置素材；否则 data URL（同 16KB / 白名单） |
| `popout.displayMs` | `7000` | 2000–20000（按 500ms 取整），到点自动收回 |
| `popout.entrance` | `'slide'` | 只读：v4 的入场固定为 clip 揭示（`hl-peek-reveal` 语义） |
| `popout.ambient` | `error`/`pending`/`completed` 为 `'breath'`，其余 `none` | 待机动效 |
| `popout.exit` | `'drop'` | 退出动效：`drop` / `particles` / `fade` / `slide-out` |
| `popout.side` | `'auto'` | `auto`（避开左侧会话栏）/ `left` / `right` |
| `sound.kind` | （v4.2 删除）| 音色改由 `sound.builtin` + `sound.uploads[]` 决定，见「音效」一节 |
| `sound.enabled` | `false` | 音效开关：`pending` / `error` / `completed` 三类事件各响一次；音量是全局 `sound.volume` |

`defaultSettings()` 里还有两个**不可配置的内部字段**，上表之外不再有别的键：`version`（存储版本，当前 `4`）、`categories.<category>.reserved`（预留类别标记，只有 `favorite` 为 `true`，前端改不动）。

设置存 `localStorage`，键 `dsh.hotlist.settings.v1`；改完即时生效（不需要刷新）。也可在控制台直接调：

```js
window.__HOTLIST_SETTINGS__.get()                      // 当前完整设置
window.__HOTLIST_SETTINGS__.set({ maxSeats: 8 })        // 局部写入，返回新设置
window.__HOTLIST_SETTINGS__.set({ categories: { idle: { within: 30 } } })  // 类别内局部写
window.__HOTLIST_SETTINGS__.reset()                    // 恢复默认
window.__HOTLIST_VERSION__                             // '4.3.1'
```

从 v3（3.0 / 3.1）升上来不用手动做任何事：读取时按迁移表把 8 个 `states` 收进 7 个 `categories`（`approval`→`pending.glyph`、`question`→`pending.glyphSecondary`、`error/completed/running/idle`→同名类、`plan-review`/`subagents` 丢弃、`showIdle`→`idle.enabled`、`overlay.enabled`→各类 `popout.enabled`），然后写回一次。v3 的 `overlay.scale` 倍数在 v4.1 没有对应物，读取时丢弃（旧数据不会坏，只是尺寸回到 260/520）。迁移细节见 `docs/ARCHITECTURE.md` §10。

## 设置页

宿主设置面板里会多一项 **热表 / Hot List**（`settings.section`，id `hotlist`，order 30），点开是 7 张折叠卡 + 一块全局区：

- **折叠态**一行就是一类：glyph 预览、类别名、「· 顺序 N」，五个只读状态小标签（Tab / 栏 / 顶 / 弹 / 音，开=高亮），右端 caret；整行约 40px 高。点整行展开，**多张卡可以同时展开**；展开状态存 `sessionStorage`（`dsh.hotlist.open`，JSON 数组），不写进设置。
- **展开区**（紧凑多列，一行放 2–3 个小控件）：
  - ① 图标：来源（emoji / 上传 / 弹出图）+ 尺寸一行；图标值独占一行（预览、字符输入、上传、清除）；动效平均间隔；
  - ② 动效：`motion` + 作用于 `glyph`/`row` + 「预览一次」一行；
  - ③ 弹出：开关 + 弹出图一行；入场 / 待机 / 退出一行三列（入场只读，固定 clip 揭示）；出现侧 / 停留时长一行两列；
  - ④ 音效：启用 / 来源（内置 21 条或上传）/ 试听（真播，绕过节流与冷启动闸门）三列；
  - ⑤ 顺序（`order`；`pinned` 卡里换成置顶列表，可上下移/移除）；
  - ⑥ `idle` 卡末尾保留一行「闲置收录窗口（分钟）」，没有组标题。
- **全局区**：`maxSeats`（含「自动」）、`collect.completedTtlMs`、`overlay.sizeMin` / `sizeMax`、`sound.volume`、`positions.tab`（`topbar` 置灰标「即将支持」）、`takeOverStatusDot` / `hideNativeDot`、**恢复默认**（点两次确认，第二击若隔了 3 秒会重新武装）。
- **`favorite` 卡只读**：全控件置灰、显示「预留」，设置写入时 `reserved` 类会被直接丢弃。
- 页面顶上按需出现两条提示：「另有 N 个待处理会话未显示」（`plan.overflow`）与「已停用：dsh-sessions-manager 的状态点将恢复显示」。
- 任何改动都当场写 `localStorage` 并广播，tab 行与侧栏图标在同一次事件里重算，**不需要刷新页面**。

## 快捷键

`Alt+Shift+[` / `]` 在会话 tab 之间前后切换（只走当前 plan，当前会话不占座位），`Alt+Shift+S` 手动弹一次浮层（设置页开关，默认关）。两个循环键总是可用；`Alt+1–9` 仍不做——web 端裸 Alt+数字被宿主 `isWebBindingAllowed` 拒，`dsh-session-hotkeys` 又在 capture 阶段抢键。热键只在 `region === 'page'`、没有 modal、非 repeat 时消费事件。

## 与 dsh-sessions-manager 的关系

两者共存。热表只做一件事：`takeOverStatusDot` 打开时用一层 CSS + inline 兜底把 dsm 的状态点隐藏（`client.js:1689` / `client.js:1722` / 样式 `client.js:1575`），其余功能（列表、搜索、管理）完全不动。关掉开关，dsm 的点立刻回来，不留残留。

## 安装

```powershell
dsh plugin --profile <profile> add C:\Meru\Seek\plugins\dsh-hotlist
dsh plugin --profile <profile> remove @local/dsh-hotlist
```

装完重启对应 profile 的 GUI。这是 Cordis bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，把插件插进配置（`- insert: [{id: hotlist, name: '@local/dsh-hotlist'}]`）。Host 半边（`index.js`）是空的，全部逻辑在浏览器侧 `client.js`。

## 已知限制

- **"刚完成"跨刷新保留**：宿主自己只把 `completionUnread` 维护 1–3 分钟并在打开会话时立刻清；热表自记 `running true→false` 的时间落盘到 `localStorage`（`dsh.hotlist.completedAt.v1`，500ms 合并写），页面重载后按 `collect.completedTtlMs` 与当前工作区剪枝恢复；打开的会话一进主视图就同刻删除。
- **"报错"只覆盖本进程**：来自 `ctx.remote.$on('api-session/error')`（live-only，重连不补发）+ 已打开会话快照里的 `promptError`/`lastAgentError`，10 分钟过期，重新运行即清除。
- **没有独立"子代理"状态**：宿主不暴露子代理信号，热表把"子代理在跑"并入 `running`。
- **`plan-review` 与 ❓ 共用**：宿主只暴露一个 `pendingInteraction.kind`，两者在图标与 tab 上不区分。
- **tab 标签只能是字符串**：宿主用字符串画标签，所以 tab 上永远只有 emoji，不能放方图。
- **`favorite` 是预留类**：结构在、设置页可看（只读）、判定永远不产出（没有"收藏"操作入口）。
- **浮层、音效与两条循环热键已接线**：`popout.*` 会真的弹出（素材在 `assets/<类别>-<档位>.webp`，离线回落到 `assets/<类别>.svg`，再回落 emoji）；`sound.*` 真的会播（冷启动首轮只记不播、同会话同类去重、1500 ms 全局节流）；`shortcuts.*` 走官方的 `ctx.shortcuts`（`registerFixed` 登记 + `observeFixedInput` 分派，不自己挂 `keydown`），`jumpEnabled` 仍是灰度。
- **动效是抽签不是常亮**：每个类别按自己的「平均间隔」掷骰子，命中才挑该类一个座位播一遍（同屏最多 2 个），所以看起来是"时不时动一下"，不是全部一直转。
- **设置与端口绑定**：`localStorage` 挂在页面 origin 上；GUI 端口变了就是另一个 origin，设置会看起来"丢了"。
- **桌面端 / 网页端**：同一份 client bundle。差异只在窗口宽度与缩放（决定 `seatLimit()` 算出的物理上限），以及有没有桌面壳带来的其它插件（影响状态点顶替）。
- **tab 行放不下时会被裁**：官方把多余 tab 折进一个点不到的菜单，所以热表自己按行宽截断（`client.js:3925`）。`pinned`/`pending`/`error` 不受 `maxSeats` 限制，但另有硬顶 `maxSeats + 4`，超出部分不显示。

## 文件

```
package.json           bundle 声明（name @local/dsh-hotlist，dsh.bundle.patch）
cordis.patch.yml      插入行
index.js              Host 半边（空 apply）
client.js             全部实现（单文件，纯 __ModuleLoader__ + React.createElement，无 jsx）
assets/               浮层素材：7 类 × 4 档 webp + 同名 svg 回落
assets/sounds/        音效 mp3（21 条内置，host 路由 /hotlist-sound/ 播放）
test/classify.test.mjs 单测（51 组）
docs/ARCHITECTURE.md  维护者文档
docs/TESTING.md       测试与真机验收
docs/EXTENDING.md     给外部脚本 / 另一个 AI 的入口（设置形状、`window.__HOTLIST__`、素材上限与批量导入）
```
