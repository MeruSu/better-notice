# 热表 · Hot List

> 把还热着的会话摆到你手边：对话区 tab 行里给每个会话一个座位，左侧会话栏行首给一枚状态图标，状态一变就响一声、弹一张图。

热表是 DSH（DeepSeek Harness）Web UI 的插件，共用同一个 profile 里的会话数据。它读宿主自己的会话状态（`sessions.list`、`uiSession.sessionStatus`），不做额外采样，把「等你动手」的会话排到最前，凉掉的留在原地。

- 插件包名：`@local/dsh-hotlist`（本地命名空间，尚未发布到 npm）
- 仓库：<https://github.com/JiaoMeru/better-notice>
- 版本：`4.3.1`（见 [CHANGELOG.md](CHANGELOG.md)）

---

## 特性

七类状态，四个显示面。**判定优先级**固定为 `pinned > pending > error > completed > running > idle`（一个会话同时「报错 + 待审批」时归 `pending`，因为待审批是唯一能动手的态）；**展示顺序**另由每类的 `order` 决定，默认 `0 / 10 / 20 / 30 / 40 / 50 / 60`。这套顺序是 tab 座位那一面的（`classify()`，`client.js:1271`）；侧栏图标是另一个纯函数 `sidebarStateOf()`（`client.js:1624`），它把 `running` 排在 `completed` 之前——所以「刚跑完又立刻重新开始跑」的会话，tab 上可能还是 ✅、侧栏已经是 ⏳（见「已知限制」第 13 条）。

| 类别 | 什么时候出现 | 对话区座位 | 侧栏图标 | 弹出图 | 音效 |
|---|---|---|---|---|---|
| 📌 `pinned` | 你在设置里钉住的会话 | ✅ | ✅（实际不显示，见限制 14） | — | — |
| ⛔ `error` | Agent 报了错（`api-session/error`），10 分钟过期 | ✅ | ✅ | ✅ | 🔈 |
| 🔐 `pending` | 等你审批 / 等你回答 / 等你过方案（副图标 ❓） | ✅ | ✅ | ✅ | 🔈 |
| ✅ `completed` | 本插件看到它跑完，7 分钟内 | ✅ | ✅ | ✅ | 🔈 |
| ⏳ `running` | 正在干活；tab 面还会把「子代理在跑、父会话空闲」算进来（侧栏不会，见限制 14） | ✅ | ✅ | — | — |
| 💤 `idle` | 空闲，且 5 分钟内动过 | ✅ | ✅ | — | — |
| ⭐ `favorite` | 预留，当前恒不产出 | — | — | — | — |

图例：✅ = 默认开；— = 默认关（弹出图、音效都能逐类打开）；🔈 = 有内置音效但**默认不响**，要自己去设置页打开。音效只有 `pending` / `error` / `completed` 三类带内置文件（每类 7 条，共 21 条），别的类别没有可播的素材。

四个面各自的语义：

- **座位**：一个会话在对话区 tab 行占一个位置，点它直接切过去。当前会话不占座位（它本身就是「对话」tab）。能放几个由 tab 行实际宽度决定，也可以写死 1–12。
- **状态图标**：左侧会话栏每行标题前一枚，emoji 或上传的方图，可带动效。
- **弹出图**：会话**首次进入**某个类别时，在窗口左下或右下角揭开一张（`position:fixed`，边长取 `overlay.sizeMin`/`sizeMax` 的中值，`clip-path` 从左往右揭开），点它切过去，到点自己收回。
- **音效**：会话进入某个类别时响一次，音量全局。

另有一条与面无关的机制：**「刚完成」跨刷新保留**。宿主自己的 `completionUnread` 只维护 1–3 分钟、一打开会话就清；热表自己记下 `running true → 非 running` 的时刻（合并写，500ms 一批），页面重载后按 `collect.completedTtlMs` 和当前工作区剪枝恢复——所以刷新页面不会把刚跑完的会话从 ✅ 里弄丢。

四个面都能关：座位与侧栏图标是全局开关（`positions.tab` / `positions.sidebar`），弹出图与音效是**逐类**开关（每张卡的 `popout.enabled` / `sound.enabled`）。三个位置全关（`tab` / `topbar` / `sidebar` 都 false）等于彻底隐身——设置页本身还在，进 设置 → 热表 会看到一行「热表当前不可见，可从设置重新打开。」（`positions.allPositionsOff`，`client.js:2882`）。

## 截图

| 对话区 tab 行里的座位 | 设置 → 热表 | 左侧会话栏的行首图标 |
|---|---|---|
| ![对话区 tab 行里的座位：图标 + 截断标题](screenshots/uploaded-glyph.png) | ![设置 → 热表：7 张类别卡，报错卡已展开](screenshots/settings-sound.png) | ![左侧会话栏行首的状态图标](screenshots/sidebar-glyphs.png) |

- 座位截图里 tab 行右侧那几个「图标 + 截断标题」的 tab 就是热表注册的座位。
- 设置页是 7 张折叠卡，一张卡一类；截图里「报错」卡已展开，可以看到图标 / 动效 / 弹出 / 音效 / 顺序五组。
- 侧栏截图里的图标是作者自定义过的字符（不是默认 emoji），说明图标可换。

仓库里的 `screenshots/settings-full.png` 与 `screenshots/tab-seats.png` 是更早版本的界面，仅作历史参考，不代表当前版本。

## 安装

需要 DSH 的 Web profile（本文档在 DSH `0.2.2-rc.1` 上核对）。

**方式一：本地目录（`link:`，开发用）**

```powershell
# 1. 克隆到任意目录，示例用 C:\src\better-notice
git clone https://github.com/JiaoMeru/better-notice.git C:\src\better-notice

# 2. 装进某个 profile
dsh plugin --profile <profile> add link:C:/src/better-notice
```

两点注意：

- **用绝对路径、正斜杠**。`dsh plugin` 是把参数在 profile 目录里转交给 pnpm 的，相对路径会指到 profile 里去。
- `link:` 装的是目录本身，之后改代码不用重装。改 `client.js` 刷新页面就生效；改 `index.js` / `cordis.patch.yml` / `package.json` 要重启 GUI（见 [CONTRIBUTING.md](CONTRIBUTING.md)「两边各改什么」）。

**方式二：按包名**

```powershell
dsh plugin --profile <profile> add @local/dsh-hotlist
```

这条只在包已发布到 registry（或本机可解析）时才成立。当前包名是本地命名空间 `@local/dsh-hotlist`，**尚未发 npm**，所以现在实际可用的只有方式一。

卸装：

```powershell
dsh plugin --profile <profile> remove @local/dsh-hotlist
```

**装完必须重启该 profile 的 GUI**（bundle patch 只在启动时读）。重启后在 设置 → 热表 里配置；想确认装上了，可以在页面控制台敲：

```js
window.__HOTLIST_VERSION__   // '4.3.1'
```

## 用法

**座位**。对话区 tab 行里，每个热会话一个座位。点击切过去；座位多了会被截断（见「已知限制」）。

**侧栏图标**。左侧会话栏每行标题前一枚状态标记。它读的是同一批会话状态与同一份设置，但判定用另一个纯函数 `sidebarStateOf()`（`client.js:1624`），与 tab 面的 `classify()`（`client.js:1271`）有两处已知差别：① 侧栏把 `running` 排在 `completed` 之前，tab 面相反；② 侧栏认宿主的 `completionUnread` 信号，tab 面只看本插件记下的 `completedAt`。因此同一个刚跑完、又立刻重新开始跑的会话，tab 上可能还是 ✅、侧栏已经是 ⏳（见「已知限制」第 13 条）。另外侧栏拿不到 `pinned` 与 `children` 这两个入参，所以置顶和「子代理在跑」在侧栏不显示（第 14 条）。`error` 的窗口两面实际都是 10 分钟：错误表在 `readSnapshot()` 里就按 `ERROR_TTL_MS` 删掉了（`client.js:4151`），侧栏函数里那个 30 分钟的 `SIDEBAR_ERROR_TTL_MS` 只是第二道闸，永远碰不到更老的条目。

两个接管开关（默认都开）：

- `takeOverStatusDot`：隐藏其它插件（`dsh-sessions-manager`）画在行首的状态点。只藏点，不改对方其它功能；关掉立刻恢复。
- `hideNativeDot`：隐藏宿主自带的状态槽。

**弹出图**。会话首次进入 `error` / `pending` / `completed` 时弹出。同一时刻只留一个位置：高优先的在弹时，低优先的直接丢弃而不排队；同一会话同一类别 10 秒内不重复弹。优先级 `error > pending > completed`。当前会话自己不弹；页面在后台（`document.hidden`）时也不弹，只在 console 记一条。点图切过去，到点自己收回。弹出图与 tab 座位是两套独立开关：`positions.tab` 关掉不影响它（`client.js:4241-4251`）。它没有像音效那样的「冷启动首轮不弹」闸门，所以页面刚打开的那一轮，已经处在这三类里的会话也会算作一次进入（`seen` 表初始为空，`client.js:3417`）。

**快捷键**。

| 按键 | 作用 |
|---|---|
| `Alt+Shift+[` | 切到上一个座位（只在当前座位环里走，两端回绕） |
| `Alt+Shift+]` | 切到下一个座位 |
| `Alt+Shift+S` | 手动弹一次速查浮层（默认关，需在设置里打开；手动弹出会跳过「首次进入」与 10 秒冷却，直接挑当前最紧急、且该类 `popout.enabled` 为开的一类，`client.js:3558`） |

按键只在页面区域（`context.region === 'page'`）、没有菜单或对话框挡住、非长按、非输入法组合、没有按着 `Ctrl`/`Cmd` 时才处理，命中就 `consume()`，不往下透传。

## 配置

设置位置：**设置 → 热表**（`settings.section`，id `hotlist`，order 30，排在官方分区之后）。7 张折叠卡 + 顶部全局区，改完即时生效，**不需要刷新页面**。

设置页的形状：

- **折叠态**一行一类：图标预览、类别名、「· 顺序 N」（`pinned` 显示「第 0 位（固定）」）、五个只读状态小标签（`Tab` / `栏` / `顶` / `弹` / `音`，开=高亮）、右端 caret；该类 `enabled` 为 false 或三个位置（`tab`/`sidebar`/`topbar`）全关时多一个「停用」小标签，`favorite` 多一个「预留」。点整行展开，**多张卡可以同时展开**。展开状态存 `sessionStorage`（`dsh.hotlist.open`，JSON 数组），不写进设置。
- **展开区**（紧凑多列）：① 图标（来源 / 尺寸 / 图标值 + 上传 / 平均间隔）；`pending` 卡多一行副图标（❓）；② 动效（`motion` + 作用于 `glyph`/`row` + 「▶ 预览一次」）；③ 弹出（开关 / 弹出图 / 入场·待机·退出 / 出现侧·停留时长）；④ 音效（启用 / 来源 `builtin`·`upload` / 「▶ 试听」，选 `upload` 才出现上传行）；⑤ 顺序；`idle` 卡末尾多一行「闲置收录窗口」，`pinned` 卡末尾多一块「置顶会话」列表（上移 / 下移 / 取消置顶）。
- **单选与数字控件**：尺寸、动效作用面用分段按钮；来源、动效名、待机/退出/出现侧用下拉；其余是数字输入框，超范围的值在写入时会被夹回。
- **全局区**（自上而下）：座位上限（−/+ 与「自动」切换）、刚完成保持时长（分钟）、全局音量（步进 5）、浮层尺寸上下限（各 120–900，步进 20）、`positions.tab`、`positions.topbar`（置灰标「即将支持」）、两个状态点开关、快捷键三条（`Alt+1..9` 直跳置灰标「下一版」、`Alt+Shift+S` 开关、循环键说明）、**全部恢复默认**（按钮文案变成「再次点击确认」，只认第二次点击；3 秒内不点就复位）。
- **`favorite` 卡只读**：全控件置灰，卡头带「预留」标签，卡内一行说明「预留：子代理活动并入 ⏳」。
- **设置页顶部的提示**按需出现：三个位置（`tab` / `topbar` / `sidebar`）全关时提示「热表当前不可见，可从设置重新打开」（逐类的弹出图、音效开关不影响这条判断）；座位超上限时提示「另有 N 个待处理会话未显示」（`N` 是本次被裁掉的座位总数，不只是待处理类）；上传出错时把原因显示在那里。「已停用：dsh-sessions-manager 的状态点将恢复显示」不是顶部提示，是 `takeOverStatusDot` 那一行自己换的副文案。
- 任何改动都当场写 `localStorage` 并广播，tab 行与侧栏图标在同一次事件里重算。写盘失败（配额满）不会静默：页脚出现「设置未能写入本地存储，本次改动只在当前页面生效。」，`window.__HOTLIST_SETTINGS__.lastError()` 能拿到原因。

### 全局默认值

| 设置 | 默认值 | 范围 / 说明 |
|---|---|---|
| `maxSeats` | `6` | `1`–`12`，或 `'auto'`（跟随 tab 行实际宽度） |
| `positions.tab` | `true` | 对话区 tab 行座位总开关 |
| `positions.sidebar` | `true` | 侧栏接管总开关：关掉整套侧栏图标都不跑（原生点的判断也读它）；设置页没有这一行，走 API |
| `positions.topbar` | `false` | 窗口顶栏，**未实现**；设置页置灰标「即将支持」（只参与「热表是否可见」的判断，不渲染） |
| `takeOverStatusDot` | `true` | 顶掉其它插件的行首状态点 |
| `hideNativeDot` | `true` | 隐藏宿主原生状态槽 |
| `collect.completedTtlMs` | `420000`（7 分钟） | 1–1440 分钟；「刚完成」保持多久 |
| `display.reduceMotion` | `'auto'` | `auto` / `on` / `off`；只走 API，设置页没有这一行。`on` = 强制停动效；`auto` 与 `off` 在代码里都不置位，系统的 `prefers-reduced-motion` 仍由样式表生效（`off` 并不能强行打开动效） |
| `shortcuts.jumpEnabled` | `true` | 灰度字段：`Alt+1..9` 未实现，设置页恒灰 |
| `shortcuts.overlayEnabled` | `false` | `Alt+Shift+S` 手动弹一次浮层 |
| `shortcuts.overlayKey` | `'Alt+Shift+S'` | 展示用；处理器按物理键 `KeyS` 判 |
| `overlay.side` | `'auto'` | `auto` / `left` / `right` |
| `overlay.sizeMin` / `sizeMax` | `260` / `520` | 120–900 px；每次弹出取两者中值（`client.js:3476`），`min > max` 写入时自动交换 |
| `overlay.fallbackImage` | `''` | **只存值，没有渲染出口**：字段保留、读进来会过图片校验，但目前没有任何代码拿它当兜底图（设置页也没有这一项） |
| `sound.volume` | `60` | 0–100，全局音量 |
| `pins` | `{}` | `{ <sessionId>: 级别 }`，级别 1–99，最多 50 条 |

### 七类默认值

| 类别 | `enabled` | `order` | `sortBy` | `surfaces.tab` | `surfaces.sidebar` | 默认图标 | 动效 | `popout.enabled` | `within` |
|---|---|---|---|---|---|---|---|---|---|
| `pinned` | ✅ | `0`（强制） | `manual` | ✅ | ✅ | 📌 | `none` | — | 0 |
| `error` | ✅ | `10` | `time` | ✅ | ✅ | ⛔ | `bounce` | ✅ | 0 |
| `pending` | ✅ | `20` | `time` | ✅ | ✅ | 🔐 + ❓(16px) | `blink` | ✅ | 0 |
| `completed` | ✅ | `30` | `time` | ✅ | ✅ | ✅ | `none` | ✅ | 0 |
| `running` | ✅ | `40` | `time` | ✅ | ✅ | ⏳ | `spin` | — | 0 |
| `idle` | ✅ | `50` | `time` | ✅ | ✅ | 💤 | `none` | — | 5 |
| `favorite` | ❌（预留） | `60` | `time` | （不产出） | （不产出） | ⭐ | `none` | — | 0 |

`idle` 默认**在 tab 行也出座位**（第三级：五分钟内动过的会话都进列表）。嫌吵可以只关 `categories.idle.surfaces.tab`（走 API，设置页没有这一项），侧栏保留。

### 每类可调的项

每类一份，字段名就是设置页的契约（`defaultCategory()`，`client.js:209`）：

- `enabled`：关掉即不判定、不出座位、不出图标。
- `order`：1–99，决定展示顺序；`pinned` 恒 0。
- `sortBy`：`time`（按最近活动倒序）/ `manual`（按 `pins` 的级别排）。只有 `pinned` 默认 `manual`，其余默认 `time`。**设置页没有这一行**，只走 API。
- `surfaces.tab` / `surfaces.sidebar` / `surfaces.topbar`：该类在各面出不出现。三项默认都是 `tab:true`、`sidebar:true`、`topbar:false`；`topbar` 没有渲染实现，改成 `true` 也不会显示东西（见「已知限制」第 7 条）。**设置页只有只读的小标签显示这三项状态**（悬停提示「位置在页面上方全局区设置。」），要改走 API。
- `glyph.source`：`emoji` / `upload` / `popout`（拿该类的弹出图当图标）。
- `glyph.kind`：`'emoji'` 或 `'img'`，由上传动作自动切换，一般不用手改。
- `glyph.value`：emoji 文本，最多 8 个字形；留空回落该类默认图标。
- `glyph.size`：16 / 20 / 24 / 32（吸附到最近一档）。
- `glyph.motion`：`none` / `spin` / `pulse` / `bounce` / `blink`。
- `glyph.motionTarget`：`glyph`（只动图标）/ `row`（图标 + 标题，仅侧栏可用）。
- `glyph.motionIntervalMs`：数据层是毫秒，`0` = 该类不动；否则 2000–60000，步进 1000，默认 8000（**设置页按秒显示**，2–60，步进 1）。
- `glyphSecondary`：仅 `pending` 有，❓ 小图标，同样带动效。
- `popout.enabled` / `popout.images[]` / `popout.builtin` / `popout.displayMs`（数据层 2000–20000 毫秒，步进 500，默认 7000；**设置页按秒**，2–20，步进 0.5）。
- `popout.entrance`：**只读**，当前固定为「探出」，设置页显示「固定为探出」（`POPOUT_ENTRANCES` 里另有三种值，但这层 UI 不提供选择）。
- `popout.ambient`：`none` / `breath` / `float`，`error`/`pending`/`completed` 默认 `breath`。
- `popout.exit`：`drop` / `particles` / `fade` / `slide-out`。
- `popout.side`：`auto` / `left` / `right`。
- `sound.enabled` / `sound.builtin` / `sound.uploads[]`：音效开关、用内置还是只用上传池。
- `within`：收录窗口（分钟，0–120），只对 `idle` 有意义。

三个不参与日常配置的内部字段：

- `version`：设置 schema 版本，当前 `4`。
- `categories.<id>.reserved`：只有 `favorite` 为 true。存储里这一类的任何值读出来都会被丢掉，永远回落默认（`enabled: false`），所以它既不判定也不产出。
- `categories.<id>.pinLevel`：遗留字段，恒 `null`；置顶位次真正的来源是顶层 `pins` 表。

从旧版本升上来不用手动做任何事：读取时按迁移表把 v3 的 8 个旧 `states` 收进 7 类（`approval` → `pending.glyph`、`question` → `pending.glyphSecondary`、`error`/`completed`/`running`/`idle` → 同名类、`plan-review` 与 `subagents` 丢弃、`showIdle` → `idle.enabled`、`overlay.enabled` → 各类 `popout.enabled`），写完再写回一次。v3 的 `overlay.scale` 倍数会被折算成 `overlay.sizeMax`（`scale × 260`，夹到 120–900 后再取不低于 260），旧键不再保留。迁移口径见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §10。

## 素材自定义

三类素材都可在设置页上传，也可用 API 批量灌：**图标**、**弹出图**、**音效**。

| 项 | 上限 | 常量 |
|---|---|---|
| 每类每池份数 | 6 份 | `ASSET_POOL_MAX` |
| 图标（编码后） | ≤ 16 KB | `GLYPH_MAX_BYTES` |
| 弹出图（编码后） | ≤ 64 KB | `POPOUT_MAX_BYTES` |
| 音效（编码后） | ≤ 128 KB | `SOUND_MAX_BYTES` |
| 全部上传合计 | ≤ 2 MB | `ASSET_TOTAL_MAX_BYTES` |
| 图标 / 弹出图的源文件 | ≤ 4 MB | `GLYPH_SOURCE_MAX_BYTES` |

音效没有单独的源文件上限：`SOUND_MAX_BYTES` 同时卡源文件和编码后的 dataURL。

格式：图标与弹出图只收 `image/png`、`image/jpeg`、`image/webp`、`image/gif`（**拒收 SVG**）；音效在设置页只收 MP3 / M4A / WAV / OGG / AAC / WebM，直接读成 dataURL，页面里不做转码（API 那一层只校验 `data:audio/…;base64,`，不限具体格式）。单份超限、池满、格式不对都只拒收你刚加的那一份，已存的留在原处；**总预算 2 MB 超出时会裁掉池尾的素材**：按类别顺序逐类处理，每类内部依次裁 `sound` → `popout` → `glyphSecondary` → `glyph`，每次都 `pool.pop()` 掉最后一份（`trimAssetBudget`，`client.js:648`），这时 `assets.add` 返回 `{ ok: false, reason: 'budget' }`。设置页对每种失败都给一行提示。

**随机规则分两种，别混**：

- **图标按「身份」定种**：种子是 `"<sessionId>|<category>"` 的 FNV-1a 哈希，同一会话在同一类别里反复渲染、刷新页面都是同一张，只有换类别才换图。
- **弹出图与音效按「事件」随机**：每弹一次、每响一次都重取一张/一条。

内置素材在 `assets/`：`<类别>-<档位>.webp`（档位 64 / 320 / 780 / 1560，由浮层尺寸挑一档）+ 同名 `.svg`（webp 加载失败时用）+ 最后一层回落 emoji；音效在 `assets/sounds/<类别>-1..7.mp3`，由宿主半边的 `/hotlist-sound/` 前缀路由自服务（DSH 的共用素材路由只认图片，`.mp3` 在那里会 404）。素材来源：`assets/*.webp` 是从作者自己的头像归档图裁切压缩来的，`assets/manifest.json` 的 `note` 写明「no generated art」，并逐类记了来源文件名、选图理由和各档体积；音效用 MiMo TTS（`mimo-v2.5-tts`，音色「茉莉」）生成，每条的文案、时长、体积都记在 `assets/sounds/manifest.json`。

## 对外 API

页面里有两个对象，给脚本和别的 AI 用。

`window.__HOTLIST_SETTINGS__`：设置存取（同对象另有旧名 `window.__SESSION_SWITCHER_SETTINGS__`，新代码别用）。

```js
const api = window.__HOTLIST_SETTINGS__;
api.version            // 4 —— 设置 schema 版本，不是插件版本
api.get()              // 当前设置对象（内部缓存本身，别就地改；要改就 set）
api.set(patch)         // 合并写入并立刻生效
api.reset()            // 全部恢复默认
api.subscribe(fn)      // 订阅变更，返回取消订阅函数
api.override(patch)    // 测试缝：临时覆盖、不落盘，生产别用
api.defaults()         // 默认设置（每次新建一份，改它不影响当前设置）
api.glyphOf(settings, token)   // 状态 token → 当前图标（emoji 或 dataURL）
api.emojiOf(settings, token)   // 状态 token → emoji 回落（tab 标签只能放字符串）
api.lastError()        // 最近一次写盘错误（字符串或 null）
```

`glyphOf` / `emojiOf` 是内部函数**原样挂出去**的，第一个参数要自己传当前设置（`api.get()`）；`token` 取值 `pinned` / `approval` / `question` / `error` / `completed` / `running` / `idle`（注意没有 `favorite`，也没有 `pending` —— 待处理在这一层分成 `approval` 与 `question`，对应主图标与 ❓ 副图标）。

`window.__HOTLIST__`：设置 + 三个素材池。

```js
const api = window.__HOTLIST__;
api.version                                  // '4.3.1'
api.settings.get() / .set(patch) / .reset() / .subscribe(fn)

api.assets.add(category, kind, { name, dataUrl })  // → { ok, reason?, bytes? }
api.assets.list(category, kind)                    // → [{ name, bytes }]
api.assets.clear(category, kind)                   // → boolean
api.assets.preview('pending')                      // 立刻试听一条该类音效 → boolean
```

- `kind`：`'glyph'` | `'popout'` | `'sound'`。
- `category`：`'pinned' | 'error' | 'pending' | 'completed' | 'running' | 'idle' | 'favorite'`。
- `add` 的 `reason` 是 `invalid` / `full` / `refused` / `budget` 之一，分别对应参数不对、池已满、格式或单份体积不合格、总预算不够。

**两个坑**：

1. `set` 只做**两级**浅合并——根字段逐个合并、`categories.<cat>` 逐个合并，再下一层（`glyph`、`popout`、`sound`）是**整块替换**。所以 `set({ categories: { error: { glyph: { size: 24 } } } })` 会把 `error.glyph` 的其余键打回默认。先 `get()`，改完整个对象再 `set()`。
2. 设置存在浏览器 `localStorage` 里，与页面 origin 绑定；GUI 端口变了就是另一个 origin，设置会看起来「丢了」。

更多例子（批量导入、按 URL 灌素材、试听的三种方式）见 [docs/EXTENDING.md](docs/EXTENDING.md)。

## 已知限制

1. **`Alt+1..9` 直跳未实现**。网页端裸 `Alt+数字` 被宿主的 `isWebBindingAllowed` 拒，第三方 `dsh-session-hotkeys` 又在 capture 阶段抢键；硬抢会持续冲突。字段与 UI 保留，标「下一版」。目前提供 `Alt+Shift+[` / `]` 循环。
2. **宿主自己的 `refreshViews` 会在会话被释放后抛一次** `uiConversation.binding: unknown session`。触发条件是「座位指向的会话被点进去后拒绝审批 / 结束」。它不在本插件调用栈里，加 `window.onerror` 全局吞会盖掉以后真出的错，故不处理；插件这边只做延后注销。
3. **⛔ 只覆盖 agent 级错误**（`api-session/error`，live-only、重连不补发）。工具执行失败不算——它不中断会话。反过来，**用户拒绝审批导致会话结束会进 ✅**：判定只看 `running true → 非 running`，与结束原因无关。
4. **没有独立的「子代理」状态**。宿主不暴露该信号，「子代理在跑」并入 `running`。
5. **`plan-review` 与 ❓ 不区分**。宿主只暴露一个 `pendingInteraction.kind`，两者在图标和 tab 上长得一样。
6. **tab 标签只能是字符串**。宿主用字符串画标签，所以 tab 上永远只有 emoji，不能放方图。
7. **窗口顶栏未实现**。`positions.topbar` / `surfaces.topbar` 只参与可见性判断，没有对应渲染，设置页置灰。
8. **`favorite` 是预留类**。结构在、设置页可看（只读），判定永远不产出——没有「收藏」操作入口。
9. **tab 行放不下会被裁**。官方把多余 tab 折进一个点不到的溢出菜单，所以热表自己按行宽算上限：`seatLimit()`（`client.js:3925`）量 `[data-conversation-tabs]` 父元素的宽度，`visible = max(1, floor((宽 − 48) / 120))`，再给官方那两位（对话、轨迹）留位置，返回 `max(1, visible − 2)`；量不到宽度时回退 6。最终上限 `maxSeats === 'auto'` 时就用它，否则取 `min(maxSeats, 它)`（`client.js:4267`）。`pinned` / `pending` / `error` 这三个「要人处理」的类别不按上限裁，但有硬顶 `上限 + 4`（`ALWAYS_OVERFLOW`），超出部分不显示（设置页提示「另有 N 个待处理会话未显示」）。
10. **动效是抽签不是常亮**。每类按自己的「平均间隔」掷骰子，命中才挑该类一个座位播一遍，同屏最多 2 个在动。
11. **音效有 1.5 秒全局节流**。两次播放间隔不足 1500ms 时后来的那条直接丢弃（不排队）；冷启动的第一轮只记不播，避免一开页面就一串声音。这条只有源码与单测口径（组 `sound player dedupe`）——真机上很难构造连续两次真实状态转换。
12. **设置与页面端口绑定**。`localStorage` 挂在 origin 上，GUI 端口变了就是另一个 origin，设置会看起来「丢了」；同一个端口重新打开就还在。
13. **tab 与侧栏的判定函数不是同一个**。`classify()`（`client.js:1271`，tab 面）与 `sidebarStateOf()`（`client.js:1624`，侧栏面）读同一批数据，但优先级有两处不同：侧栏 `running` 先于 `completed`，tab 面 `completed` 先于 `running`；侧栏还认宿主的 `completionUnread`，tab 面只认本插件记下的 `completedAt`。所以「刚跑完又立刻重新开始跑」的会话会短暂出现「tab 还是 ✅、侧栏已经 ⏳」。这是两面的取舍，不是待修的 bug；真要统一，改这两处分支即得（见 `docs/EXTENDING.md` 开头）。
14. **侧栏看不到「置顶」和「子代理在跑」**。侧栏适配器调用 `sidebarStateOf()` 时只传了 `session` / `status` / `error` / `completedAt` / `settings` / `now`（`client.js:1884-1891`）；虽然 `readSession` 备好了 `pinned` 与 `children`（`client.js:4329-4330`），这两个值没有被传进去。结果：置顶会话在侧栏显示的是它当下的其它状态（或没有图标），不会显示 📌；「子代理在跑、父会话空闲」在侧栏也不会并入 ⏳——这两条只对 tab 面生效。

## 开发

```powershell
cd C:\src\better-notice

node --check client.js                       # client.js 是包在模块加载器里的单文件，语法错只在真机 boot 时炸
node --check index.js
node test/classify.test.mjs                  # 期望最后一行：PASS — 53 groups
```

单测把真实的 `client.js` 源文件读进来，塞进 `window.__ModuleLoader__` 的桩里执行：假的是浏览器（手写的极简 `window` / `document`，不引 jsdom，`React` 也是桩），跑的是真源码。里面还带两道静态扫描：`no undefined constants`（引用未声明的常量）和 `styles stay valid`（注入的样式选择器合法性）。改代码前的最小回归清单见 [docs/TESTING.md](docs/TESTING.md) §3。

目录：

```
client.js              全部界面逻辑（浏览器侧）
index.js               宿主侧：注册 /hotlist-sound/ 音频路由
cordis.patch.yml       bundle 插入行
assets/                7 类 × 4 档弹出图/图标素材 + 同名 svg 回落
assets/sounds/         21 条内置音效（pending / error / completed 各 7 条）
test/classify.test.mjs 单测
docs/                  架构、测试、扩展三份维护者文档
```

改代码、提 PR 的约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [CONTRIBUTING.md](CONTRIBUTING.md) — 开发环境、验证步骤、提交规范
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 模块结构、判定与排序语义，以及那些「看起来脏但换干净写法会更糟」的约束
- [docs/TESTING.md](docs/TESTING.md) — 53 组单测各验什么、真机验收清单
- [docs/EXTENDING.md](docs/EXTENDING.md) — 对外 API、设置形状、素材上限与批量导入
- [CHANGELOG.md](CHANGELOG.md) — 版本历史

## 许可

代码是 MIT，见 [LICENSE](LICENSE)（Copyright (c) 2026 Meru）。随仓库分发的内置素材（`assets/*.webp`、`assets/*.svg`、`assets/sounds/*.mp3`）来自作者自己的素材与 TTS 生成，出处记在各自的 `manifest.json` 里；想换成自己的，按上面的「素材自定义」传进去即可。