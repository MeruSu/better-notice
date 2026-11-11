# Better Notice

> 把还活着的会话摆到你手边：对话区 tab 行里给每个会话一个座位，左侧会话栏行首给一枚状态图标，状态一变就响一声、弹一张图。

Better Notice（中文名「热表」）是 [DeepSeek Harness](https://github.com/deepseek-ai) Web UI 的插件。它读宿主自己的会话状态（`sessions.list`、`uiSession.sessionStatus`），不做额外采样，把「等你动手」的会话排到最前，凉掉的留在原地。

- npm 包名：`@merusu/dsh-better-notice`
- 仓库：<https://github.com/MeruSu/better-notice>
- 版本：`4.5.0`（见 [CHANGELOG.md](CHANGELOG.md)）
- 许可：MIT

---

## 它解决什么

DSH 的会话栏是按时间排的一列。会话一多，你分不清哪一个在等你审批、哪一个刚跑完、哪一个报错了——只能一个个点进去看。

Better Notice 把它们分成七类，摊到三个地方：

- **对话区 tab 行**：每个热会话占一个 tab 座位，点一下直接切过去（当前会话不占座位，它本身就是「对话」tab）。
- **左侧会话栏**：每行标题前一枚状态图标（emoji 或上传的方图），可带动效。
- **状态变化时**：响一声提示音 + 弹一张状态图。

## 特性

| 类别 | 什么时候出现 | 座位 | 侧栏图标 | 弹出图 | 音效 |
|---|---|---|---|---|---|
| 📌 `pinned` | 你在设置里钉住的会话 | ✅ | ✅ | — | — |
| ⛔ `error` | Agent 报了错（`api-session/error`），10 分钟过期 | ✅ | ✅ | ✅ | 🔈 |
| 🔐 `pending` | 等你审批 / 等你回答 / 等你过方案（副图标 ❓） | ✅ | ✅ | ✅ | 🔈 |
| ✅ `completed` | 本插件看到它跑完，7 分钟内 | ✅ | ✅ | ✅ | 🔈 |
| ⏳ `running` | 正在干活（含「子代理在跑、父会话空闲」） | ✅ | ✅ | — | — |
| 💤 `idle` | 空闲，且最后活动在「最近对话展示时间」内（默认 5 分钟） | ✅ | ✅ | — | — |
| ⭐ `favorite` | 预留，当前恒不产出 | — | — | — | — |

图例：✅ = 默认开；— = 默认关（弹出图、音效可逐类打开）；🔈 = 有内置音效但**默认不响**，要去设置页打开。

**判定优先级**固定为 `pinned > pending > error > completed > running > idle`（一个会话同时「报错 + 待审批」时归 `pending`，因为待审批是唯一能动手的态）；**展示顺序**另由每类的 `order` 决定，默认 `0 / 10 / 20 / 30 / 40 / 50 / 60`。

另有一条与面无关的机制：**「刚完成」跨刷新保留**。宿主自己的 `completionUnread` 只维护 1–3 分钟、一打开会话就清；Better Notice 自己记下 `running true → 非 running` 的时刻（合并写，500ms 一批），页面重载后按 `collect.completedTtlMs` 和当前工作区剪枝恢复——刷新页面不会把刚跑完的会话从 ✅ 里弄丢。

## 安装

需要 Node 22+ 与一个已经跑得起来的 DSH Web profile。本文档在 DSH `0.2.2-rc.1` 上核对。

**方式一：本地目录（推荐，当前唯一实测可用的方式）**

```powershell
# 1. 克隆到任意目录，示例用 C:\src\better-notice
git clone https://github.com/MeruSu/better-notice.git C:\src\better-notice

# 2. 装进某个 profile（<profile> 换成你的 profile 名）
dsh plugin --profile <profile> add C:/src/better-notice

# 3. 重启这个 profile 的 GUI —— 必须重启，见下
dsh --profile <profile>
```

两点注意：

- **用绝对路径、正斜杠**。`dsh plugin` 是把参数在 profile 目录里转交给 pnpm 的，相对路径会指到 profile 里去。
- 装的是目录本身（`link:`），之后改代码不用重装。改 `client.js` 刷新页面就生效；改 `index.js` / `cordis.patch.yml` / `package.json` 要重启 GUI。

**方式二：按包名**

```powershell
dsh plugin --profile <profile> add @merusu/dsh-better-notice
```

这条只在包已发布到 registry 时才成立。当前**尚未发布到 npm**，所以现在实际可用的只有方式一。

卸装：

```powershell
dsh plugin --profile <profile> remove @merusu/dsh-better-notice
```

### 为什么必须重启

这是 Cordis bundle，两个半边：

- `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`，往配置里插一行 `- insert: [{id: hotlist, name: '@merusu/dsh-better-notice'}]`；
- **Host 半边** `index.js` 注册 `/hotlist-sound` 前缀路由，把内置 wav 音效发给页面（DSH 的共用素材路由只认图片，`.wav`/`.mp3` 在那里会 404）；
- **Client 半边** `client.js` 由 `dsh.client` 声明（平台 `web`、`immediately`），注册 tab 座位、侧栏图标、浮层与设置页。

新增 host 路由这一步在进程启动时完成，只刷新页面不够。

### 装完怎么确认成功

在 GUI 里打开浏览器控制台，依次确认：

1. `window.__HOTLIST_VERSION__` → 返回版本号，例如 `'4.5.0'`；
2. `typeof window.__HOTLIST__` → `'object'`，`Object.keys(window.__HOTLIST__)` → `['version','settings','assets']`；
3. 设置（账号菜单 →「设置」）左导航出现 **「热表」**，点开是 7 张折叠卡 + 一块全局区；
4. 侧栏的会话行前面出现状态图标；
5. 页面顶部**不应**出现 `Failed to load plugins` 横幅——出现就是没装好，看控制台第一条报错。

音效路由自检（同一控制台）：

```js
await fetch('/hotlist-sound/attention.wav').then(r => [r.status, r.headers.get('content-type')])
// → [200, 'audio/wav']
```

## 用法

**座位。** 对话区 tab 行里，每个热会话一个座位，点击切过去。能放几个由 tab 行实际宽度决定，也可以写死 1–12（`maxSeats`）。座位多了会被截断：`pinned` / `pending` / `error` 这三个「要人处理」的类别不按上限裁，但有硬顶 `上限 + 4`。

**侧栏图标。** 左侧会话栏每行标题前一枚状态标记。它读同一批会话状态与同一份设置，判定用 `sidebarStateOf()`，与 tab 面的 `classify()` 有两处已知差别（`running` 与 `completed` 的先后、是否认宿主的 `completionUnread`），见「已知限制」第 9 条。

**弹出图。** 会话首次进入 `error` / `pending` / `completed` 时从窗口贴边探出。同一时刻只留一个位置：高优先的在弹时，低优先的直接丢弃而不排队；同一会话同一类别 10 秒内不重复弹。优先级 `error > pending > completed`。当前会话自己不弹；页面在后台（`document.hidden`）时也不弹。

**音效。** 会话进入某类时响一次。三道闸：冷启动首轮只记不播、同会话同类去重（离开即清）、全局 1500ms 节流（后来的直接丢弃，不排队）。音量是全局的。

**快捷键。**

| 按键 | 作用 |
|---|---|
| `Alt+Shift+[` | 切到上一个座位（只在当前座位环里走，两端回绕） |
| `Alt+Shift+]` | 切到下一个座位 |
| `Alt+Shift+S` | 手动弹一次浮层（默认关，需 `shortcuts.overlayEnabled`） |

按键只在页面区域、没有菜单或对话框挡住、非长按、非输入法组合、没有按着 `Ctrl`/`Cmd` 时才处理。`Alt+1..9` 直跳**未实现**——网页端裸 Alt+数字被宿主的 `isWebBindingAllowed` 拒，`dsh-session-hotkeys` 又在 capture 阶段抢键。

## 配置

设置位置：**账号菜单 →「设置」→ 左导航「热表」**（`settings.section`，id `hotlist`，order 30）。7 张折叠卡 + 顶部全局区，**改完即时生效，不需要刷新页面**。

- **折叠态**一行一类：图标预览、类别名、「· 顺序 N」、五个只读状态小标签（Tab / 栏 / 顶 / 弹 / 音，开=高亮）、右端 caret。点整行展开，**多张卡可以同时展开**。展开状态存 `sessionStorage`（`dsh.hotlist.open`），不写进设置。
- **展开区**（紧凑多列）：① 图标（来源 / 上传 / 图标值 / 播放频率滑块）；② 动效（`motion` + 作用于 `glyph`/`row`）；③ 弹出（开关 / 弹出图 / 入场·待机·退出 / 出现侧·停留时长）；④ 音效（启用 / 来源 / 试听）；⑤ 顺序。
- **全局区**：座位上限（含「自动」）、刚完成保持时长（分钟）、全局音量、**最近对话展示时间**（0–120 分钟）、`positions.tab`、`positions.topbar`（置灰「即将支持」）、`takeOverStatusDot`。
- 非法值写入时会被夹回范围；写盘失败（localStorage 配额满）会在页脚提示，`window.__HOTLIST_SETTINGS__.lastError()` 能拿到原因。

### 全局默认值

| 设置 | 默认值 | 范围 / 说明 |
|---|---|---|
| `maxSeats` | `6` | `1`–`12`，或 `'auto'`（跟随 tab 行实际宽度） |
| `positions.tab` | `true` | 对话区 tab 行座位总开关 |
| `positions.sidebar` | `true` | 侧栏总开关（设置页无此行，走 API） |
| `positions.topbar` | `false` | 窗口顶栏，**未实现**，设置页置灰 |
| `takeOverStatusDot` | `true` | 顶掉其它插件（`dsh-sessions-manager`）画的行首状态点 |
| `hideNativeDot` | `true` | 隐藏宿主原生状态槽（v4.4 起设置页无此行，字段保留） |
| `collect.completedTtlMs` | `420000`（7 分钟） | 1–1440 分钟 |
| `collect.recentWindowMinutes` | `5` | 0–120 分钟；`0` = 不显示 `idle` |
| `sound.volume` | `60` | 0–100 全局音量 |
| `overlay.side` | `'auto'` | `auto` / `left` / `right` |
| `overlay.sizeMin` / `sizeMax` | `260` / `520` | 120–900px（v4.5 起设置页无此行，取中值再按视口收窄） |
| `pins` | `{}` | `{ <sessionId>: 级别 1–99 }`，最多 50 条 |
| `shortcuts.jumpEnabled` / `overlayEnabled` / `overlayKey` | `true` / `false` / `'Alt+Shift+S'` | v4.4 起设置页无这几行，键照样工作 |

### 每类可调的项（`categories.<id>.*`）

| 设置 | 默认值 | 说明 |
|---|---|---|
| `enabled` | 前 6 类 `true`，`favorite` `false` | 关掉即不判定、不出座位、侧栏不出图标 |
| `order` | `10`…`60` | 1–99，`pinned` 强制 0 |
| `sortBy` | `'time'`（`pinned` 为 `'manual'`） | `time` = 最近活动倒序；`manual` = 按 `pins` 级别 |
| `surfaces.tab` / `.sidebar` / `.topbar` | 前两项 `true`，topbar `false` | 该类在各面出不出现（设置页只读显示） |
| `glyph.source` | `'emoji'` | `emoji` / `upload` / `popout`（拿该类弹出图当图标） |
| `glyph.value` | 见上表 | emoji，最长 8 个字形 |
| `glyph.uploads` | `[]` | 上传方图池，最多 6 张，单张 ≤16KB，`png/jpeg/webp/gif`（**拒 svg**） |
| `glyph.motion` / `.motionTarget` | 见上表 / `'glyph'` | 动效名 / `glyph` 或 `row`（图标 + 标题一起动） |
| `glyph.frequency` | `1` | 0–1（步进 0.05）：`1` = 每拍都播，越左越稀，`0` = 不播 |
| `popout.enabled` | `error`/`pending`/`completed` 为 `true` | 该类别进入时是否弹浮层 |
| `popout.builtin` / `.images` | `true` / `[]` | 内置素材 或 从上传池随机取（每池最多 6 张，单张 ≤64KB） |
| `popout.displayMs` | `7000` | 2000–20000（500ms 取整） |
| `popout.entrance` | `'slide'` | **只读**，固定 clip 揭示 |
| `popout.ambient` / `.exit` / `.side` | `breath` / `drop` / `'auto'` | 待机 / 退出动效 / 出现侧 |
| `sound.enabled` | `false` | 音效开关 |
| `sound.builtin` | `true` | `true` = 用内置两个 wav：`pending`/`error` → `attention.wav`，`completed` → `complete.wav` |
| `sound.uploads` | `[]` | 上传音效池，最多 6 条，单条 ≤128KB |

## 素材自定义

三类素材都可在设置页上传，也可用 API 批量灌：**图标**、**弹出图**、**音效**。

| 项 | 上限 |
|---|---|
| 每类每池份数 | 6 份 |
| 图标（编码后） | ≤ 16 KB |
| 弹出图（编码后） | ≤ 64 KB |
| 音效（编码后） | ≤ 128 KB |
| 全部上传合计 | ≤ 2 MB |
| 图标 / 弹出图的源文件 | ≤ 4 MB |

格式：图标与弹出图只收 `image/png`、`image/jpeg`、`image/webp`、`image/gif`（拒收 SVG）；音效收 MP3 / M4A / WAV / OGG / AAC / WebM。单份超限、池满、格式不对都只拒收刚加的那一份；总预算超出时会按类别顺序裁掉池尾素材。

**随机规则分两种，别混**：

- **图标按「身份」定种**：种子是 `"<sessionId>|<category>"` 的 FNV-1a 哈希——同一会话在同一类别里反复渲染、刷新页面都是同一张，只有换类别才换图。
- **弹出图与音效按「事件」随机**：每弹一次、每响一次都重取一份。

内置素材在 `assets/`：`<类别>-<档位>.webp`（档位 64 / 320 / 780 / 1560）+ 同名 `.svg`（webp 失败时用）+ 最后一层回落 emoji；音效是 `assets/sounds/{attention,complete}.wav`，由 host 半边的 `/hotlist-sound/` 前缀路由自服务。

## 对外 API

页面里有两个对象，给脚本和别的 AI 用。

```js
// 设置存取
const s = window.__HOTLIST_SETTINGS__;
s.version          // 4 —— 设置 schema 版本，不是插件版本
s.get()            // 当前设置（内部缓存本身，别就地改）
s.set(patch)       // 合并写入并立刻生效
s.reset()          // 全部恢复默认
s.subscribe(fn)    // 订阅变更，返回取消订阅函数
s.defaults()       // 默认设置（每次新建一份）
s.lastError()      // 最近一次写盘错误（字符串或 null）

// 设置 + 三个素材池
const api = window.__HOTLIST__;
api.version                                     // '4.5.0'
api.settings.get() / .set(patch) / .reset() / .subscribe(fn)
api.assets.add(category, kind, { name, dataUrl })  // → { ok, reason?, bytes? }
api.assets.list(category, kind)                    // → [{ name, bytes }]
api.assets.clear(category, kind)                   // → boolean
api.assets.preview('pending')                      // 立刻试听 → boolean
```

- `kind`：`'glyph'` | `'popout'` | `'sound'`。
- `category`：`'pinned' | 'error' | 'pending' | 'completed' | 'running' | 'idle' | 'favorite'`。
- `add` 的 `reason` 是 `invalid` / `full` / `refused` / `budget` 之一。

**两个坑**：

1. `set` 只做**两级**浅合并——根字段与 `categories.<cat>` 逐个合并，再下一层（`glyph`、`popout`、`sound`）是**整块替换**。所以 `set({ categories: { error: { glyph: { frequency: 0.5 } } } })` 会把 `error.glyph` 其余键打回默认。先 `get()`，改完整个对象再 `set()`。
2. 设置存在浏览器 `localStorage`，与页面 origin 绑定；GUI 端口变了就是另一个 origin，设置会看起来「丢了」。

更多例子（批量导入、按 URL 灌素材、试听的三种方式）见 [docs/EXTENDING.md](docs/EXTENDING.md)。

## 已知限制

1. **`Alt+1..9` 直跳未实现**。网页端裸 Alt+数字被宿主 `isWebBindingAllowed` 拒，第三方 `dsh-session-hotkeys` 又在 capture 阶段抢键。字段与 UI 保留。目前提供 `Alt+Shift+[` / `]` 循环。
2. **宿主自己的 `refreshViews` 会在会话被释放后抛一次** `uiConversation.binding: unknown session`。触发条件是「座位指向的会话被点进去后拒绝审批 / 结束」。它不在本插件调用栈里，加 `window.onerror` 全局吞会盖掉以后真出的错，故不处理。
3. **⛔ 只覆盖 agent 级错误**（`api-session/error`，live-only、重连不补发）。工具执行失败不算。反过来，**用户拒绝审批导致会话结束会进 ✅**：判定只看 `running true → 非 running`，与结束原因无关。
4. **没有独立的「子代理」状态**。宿主不暴露该信号，「子代理在跑」并入 `running`。
5. **`plan-review` 与 ❓ 不区分**。宿主只暴露一个 `pendingInteraction.kind`。
6. **tab 标签只能是字符串**。宿主用字符串画标签，所以 tab 上永远只有 emoji，不能放方图。
7. **窗口顶栏未实现**。`positions.topbar` / `surfaces.topbar` 只参与可见性判断。
8. **`favorite` 是预留类**。结构在、设置页可看（只读），判定永远不产出——没有「收藏」操作入口。
9. **tab 与侧栏的判定函数不是同一个**。`classify()`（tab 面）与 `sidebarStateOf()`（侧栏面）读同一批数据，但优先级有两处不同：侧栏 `running` 先于 `completed`，tab 面相反；侧栏还认宿主的 `completionUnread`，tab 面只认本插件记下的 `completedAt`。所以「刚跑完又立刻重新开始跑」的会话会短暂出现「tab 还是 ✅、侧栏已经 ⏳」。这是两面的取舍，不是待修的 bug。
10. **tab 行放不下会被裁**。官方把多余 tab 折进一个点不到的溢出菜单，所以本插件自己按行宽算上限。
11. **动效是抽签不是常亮**。每类按自己的播放频率掷骰子，命中才挑该类一个座位播一遍，同屏最多 2 个在动。
12. **音效有 1.5 秒全局节流**。两次播放间隔不足 1500ms 时后来的那条直接丢弃；冷启动的第一轮只记不播。这条只有源码与单测口径（组 `sound player dedupe`）——真机上很难构造连续两次真实状态转换。
13. **设置与页面端口绑定**。`localStorage` 挂在 origin 上，GUI 端口变了就是另一个 origin。

## 开发

```powershell
cd C:\src\better-notice

node --check client.js          # client.js 包在模块加载器里，语法错只在真机 boot 时炸
node --check index.js
node test/classify.test.mjs     # 期望最后一行：PASS — 58 groups
```

单测把真实的 `client.js` 源文件读进来，塞进 `window.__ModuleLoader__` 的桩里执行：假的是浏览器（手写的极简 `window` / `document`，不引 jsdom，`React` 也是桩），跑的是真源码。里面还带几道静态扫描：引用未声明的常量、注入样式选择器合法性、快捷键 label 必须是 thunk。

改代码、提 PR 的约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 目录

```
client.js              全部界面逻辑（浏览器侧）
index.js               宿主侧：注册 /hotlist-sound/ 音频路由
cordis.patch.yml       bundle 插入行
assets/                7 类 × 4 档弹出图/图标素材 + 同名 svg 回落
assets/sounds/         内置音效（attention.wav / complete.wav）
test/classify.test.mjs 单测（58 组）
docs/                  架构、测试、扩展三份维护者文档
tools/meru-tts/        TTS 小工具（生成提示音用，不参与插件运行）
```

### 会踩的坑（先说）

- **传给宿主的回调必须是 thunk**。宿主在 `refreshLabels()` 里直接调 `command.label()`；传字符串会让整个 `uiWorkspace` 起不来，只看到一条 `Failed to load plugins`（v4.3.0 就是这么挂的）。单测里的 `shortcuts` 是桩，桩不调用 `label()`，所以这个错在单测里永远看不见——桩必须真的调一次。
- **`.wav` / `.mp3` 走不了素材路由**。`dsh-client-modules` 的 package-asset 只认图片，音频靠 `index.js` 自己注册前缀路由。
- **我们注册的静态路由不鉴权**。`/hotlist-sound/*` 与 `/plugins/.../assets/*` 都不校验 token，只放公开素材。
- **包名、模块 id、`dsh.profile.bundles` 三者必须一致**。`client.js` 里 `window.__ModuleLoader__.load({ id })` 的 id 必须等于 `package.json` 的 `name`，否则报 `loaded without registering` 而页面看不出异常。
- **桌面端顶部 40px 是拖拽带**（`-webkit-app-region: drag`），浮层不要往那里放。

## 文档

- [CONTRIBUTING.md](CONTRIBUTING.md) — 开发环境、验证步骤、提交规范
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 模块结构、判定与排序语义，以及那些「看起来脏但换干净写法会更糟」的约束
- [docs/TESTING.md](docs/TESTING.md) — 58 组单测各验什么、真机验收清单
- [docs/EXTENDING.md](docs/EXTENDING.md) — 对外 API、设置形状、素材上限与批量导入
- [CHANGELOG.md](CHANGELOG.md) — 版本历史

## 许可

代码是 MIT，见 [LICENSE](LICENSE)。

随仓库分发的内置素材：`assets/*.webp` 来自作者自己的头像归档图（裁切压缩），`assets/sounds/*.wav` 用 MiMo TTS 生成，出处记在各自的 `manifest.json` 里。想换成自己的，按「素材自定义」传进去即可。
