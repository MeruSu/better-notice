# 热表测试指南

分两层：能在 Node 里跑的（单测，快、必须过），和只能在真机 GUI 上看的（单测替代不了）。

## 1. 单测

```powershell
cd C:\Meru\Seek\plugins\dsh-hotlist
node --check client.js
node --check index.js
node --check test/classify.test.mjs
node test/classify.test.mjs       # 期望最后一行: PASS — 52 groups，exit 0
```

`node --check` 是必须的：`client.js` 是包在 `window.__ModuleLoader__.load({factory})` 里的单文件脚本，语法错只在真机 boot 时才炸。

patch 校验（js-yaml 从本机 profile 借）：

```powershell
node --input-type=module -e "import {createRequire} from 'node:module';import fs from 'node:fs';const r=createRequire('C:/Users/DELL/.dsh/profiles/desktop/node_modules/noop.js');console.log(JSON.stringify(r('js-yaml').load(fs.readFileSync('cordis.patch.yml','utf8'))))"
```

期望 `[{"insert":[{"id":"hotlist","name":"@local/dsh-hotlist"}]}]`。

### 1.1 测试怎么加载真代码

`test/classify.test.mjs` 不用 import：它 stub 一个 `window.__ModuleLoader__.load` 抓住 factory，再 `new Function(source)()` 执行**真实的 client.js 源文件**，拿回模块的导出（`classify`、`sortSeats`、`buildSeatPlan`、`sanitizeSettings`、`migrateSettings`、`createSidebarAdapter`…）。所以测的是真代码，假的是浏览器环境：`document` / `localStorage` / `React` / cordis `ctx`。

### 1.2 52 组各测什么

| 组 | 位置 | 覆盖 |
| --- | --- | --- |
| heal view preferences | `test:457` | 加载时把遗留座位 id（`hotlist-seat-*` / `seat-*` / `session-switcher` / `hotlist`）的 view 偏好改回 `chat`，其它键原样保留 |
| settings read/write | `test:467` | 默认值形状（`version` 4、无 `placement`、`positions` 三键、`overlay.scale` 1、`idle.surfaces.tab` **true**）、越界归一（`maxSeats:0→1`、`40→12`、TTL 夹取）、旧键迁移、`window.__HOTLIST_SETTINGS__` 形状 |
| migrate v3 to v4 | `test:507` | v3 数据逐项迁移：`approval→pending.glyph`、`question→pending.glyphSecondary`、`plan-review`/`subagents` 丢弃、`showIdle→idle.enabled`、`completedTtlMs→collect`、`overlay.enabled→popout.enabled`、`overlay.scale` 吸附、`customImage→fallbackImage`，写回后旧键不残留 |
| current version keeps custom order | `test:570` | 已是 v4 的记录原样保留用户改过的 `order`/`enabled`，不再走迁移 |
| alpha version 5 normalizes safely | `test:586` | alpha 工件里的 `version: 5` 安全归一化成 v4（保留它写下的 `categories`） |
| bad data falls back | `test:601` | 逐字段回落：未知类别丢弃、`kind:'animated'`→emoji、svg 拒收、`pins` 夹取/丢非数字、`overlay.scale:99→3`、`favorite` 恒 disabled |
| seven categories | `test:642` | 7 类各出一个会话（`favorite` 永不产出）；`idle` 是窗口：5 分钟内收录，多 1ms 不收 |
| pending merge and subagents | `test:703` | `approval`/`question`/`plan-review` 三态归 `pending`（副图标区分）；子代理在跑归 `running`；同会话多态取最高级 |
| pinned first | `test:733` | `pins` 命中的会话进 `pinned`，`pinLevel` 决定类内顺序，且恒在 `error` 之前（不管 `order` 怎么设） |
| category order | `test:755` | 改 `categories.<id>.order` 立刻改变 tab 座位顺序；同 `order` 时按 `CATEGORY_ORDER` 稳定 |
| plan limit and current session | `test:777` | 当前会话不占座位；非紧急类按 `limit` 截断，被截的计入 `plan.overflow`（`limit:2` + 1 个窗口内 idle → `overflow===1`） |
| urgent overflow hard cap | `test:809` | `pinned`/`pending`/`error` 不受 `limit` 限制但受 `limit + ALWAYS_OVERFLOW(4)` 硬顶：`maxSeats=1` + 7 个 pending → 5 座、`plan.overflow === 2` |
| surface gating | `test:827` | 每类 `surfaces.tab`/`surfaces.sidebar` 单独生效（默认全开时 idle 在 tab 也有座位；显式关掉 `idle.surfaces.tab` 后 tab 无、侧栏有）；三类全关等于该类不生产座位（`categoryAllOff`） |
| idle third tier on the tab row | `test:846` | 默认 `idle.surfaces.tab===true` 且 `within===5`：窗口内普通会话在 `surface:'tab'` 下必须产出 `idle` 行；`within:0` 不产出；`surfaces.tab:false` 不产出 |
| labels | `test:864` | `labelOf`：图标 + 截断标题，无标题用「未命名会话」，图标来自设置（`emojiOf` / `glyphSecondary`） |
| sidebar priority | `test:875` | `sidebarStateOf` 的优先级与 `surfaces.sidebar`/`enabled` 门控 |
| settings sanitizing | `test:894` | `sanitizeSettings` 纯函数容错：gif 收、svg 拒、`animated` 拒、扁平旧字段兼容、`positions` 全关、`dock` 丢弃、`within` 只对 idle 生效、`mergePatch` 逐类合并 |
| settings surface | `test:937` | `window.__HOTLIST_SETTINGS__` 的方法集、`override()` 测试缝、旧别名同对象 |
| adapter plan | `test:957` | tab 适配器整体：注册顺序、只变 `updatedAt` 不重注册、点座位切会话（幂等）、`openSession` 拒收不抛 |
| adapter sidebar markers | `test:1027` | marker 插在标题前、幂等、row 动效只写 `opacity`/`translate`（不出现 `scale`）、stop 全还原、`misses()===0` |
| takeover gate | `test:1063` | takeover style 注入/移除、dsm 点 inline 还原、`[[…]]` 不出现 |
| styles stay valid | `test:1094` | 所有注入的样式文本选择器合法、不含二次包裹 |
| settings page | `test:1130` | section 注册（id、order 30、label「热表」）、页根 `data-hotlist-settings="v4.3.1"`、全局区行键齐、7 张卡按 order 排、折叠态 35 个 chip（每卡 topbar 一个 disabled）、favorite 卡显示「预留」 |
| settings page card order | `test:1193` | 改 `categories.error.order = 5` 后卡片顺序变 `pinned, error, …`，`favorite` 恒在末位 |
| settings page favorite locked | `test:1206` | `favorite` 卡展开后所有 `input/select/button` 都 disabled、显示「预留」；`sanitizeCategory` 对 `reserved` 类短路 |
| settings page overflow notice | `test:1225` | `publishOverflow(3)` 后页面出现 `[data-hotlist-overflow]`，文案带计数；归零后消失 |
| settings upload gate | `test:1245` | `glyphUploadReject`：非图片→`type`、svg→`type`、gif 放行、>16KB→`size`；超限 data URL 在 `sanitizeSettings` 里回落 emoji |
| settings reset drops legacy keys | `test:1258` | 写入带 `states`/`glyphs`/`motion`/`placement`/`showIdle` 的记录后 `resetSettings()`：存储是 `version:4` 且旧键一个不留 |
| settings maxSeats applies at once | `test:1280` | `writeSettings({maxSeats:2})` 后两轮 `tick()` 座位数从 3 → 2；改回 6 恢复 3（两级延迟注销） |
| popout side resolution | `test:1326` | `resolvePopoutSide`：`left`/`right` 直通；`auto` 量 `.mP3x-q_sidebarCol`（>40px 走 right，量不到走 left）；同时测 `tierFor` / `sizeFor` / `assetRef` / `fallbackRef` / `dropDistance` |
| popout priority arbitration | `test:1353` | 单槽：`completed` 弹后 `pending` 抢占、`error` 再抢占；低优先遇到高优先丢弃（不排队）；同级抢占换会话 |
| popout seq guard | `test:1369` | 旧 `displayMs` 定时器回调不能关掉新浮层（单调 `seq` 比对） |
| popout reduce merge | `test:1402` | `display.reduceMotion:'on'` 与系统偏好合并成 `isReduced`：`data-reduce-motion="1"`、`--hl-enter-ms:120ms`、退场固定 `fade`（没有 `drop`） |
| popout cooldown | `test:1424` | 同会话同类别 10s 冷却（9999ms 拒、10001ms 放行）；另一个会话不受冷却 |
| popout first entry only | `test:1436` | 只在会话**首次进入**类别时弹：持续 `pending` 不重弹；当前会话不弹；换类别且冷却已过才弹 |
| overlay size sanitising | `test:1469` | `overlay.sizeMin/sizeMax`：缺省回落 260/520、越界夹到 120–900、`min>max` 自动交换；`sanitizeOverlaySize` 只认数字 |
| glyph motion interval sanitising | `test:1484` | `glyph.motionIntervalMs`：`0` 保留（该类永不动）、`500→2000`、`2500→3000`（1000 步进）、`300000→60000` |
| glyph source resolution | `test:1499` | `glyph.source` 三态：`upload` 走 data URL、`popout` 走该类别弹出图（`builtin:<cat>` 解析成打包 SVG）、`emoji` 走文本；空 emoji 回落类别内置图标 |
| sidebar motion bursts | `test:1534` | 时隙调度：一个 tick 内到期的类各掷一次骰子、并发上限 2（第 3 个类不再掷）、`reduceMotion:on` 全停且不掷、间隔 0 不掷 |
| settings page multiple open cards | `test:1599` | `dsh.hotlist.open` 存 JSON 数组：多张卡同开、未知 id 过滤、旧裸字符串按单元素数组读 |
| settings page densified rows | `test:1626` | 展开态排版：`.hl-rowMulti` 列数（弹出组 3 列 / 出现侧 2 列 / 音效 3 列）、`entrance` 只读且带固定提示 `title`、`idle` 卡内联 `within` 行、控件下限 |
| settings reset auto-disarms | `test:1659` | 「恢复默认」二次确认 3 秒后自动解除；再点一次立即复原（不会残留 armed 状态） |
| completedAt persistence | `test:1698` | `✅` 时间落盘：同一轮多次完成只写一次、成为主视图立刻删除并落盘、重启后按 TTL 与工作区剪枝；列表 `phase` 未 `ready` 时一律不剪枝（reload 不得把读回的条目写成空） |
| no undefined constants | `test:1792` | 静态扫描：剥掉注释/字符串后，任何 `[A-Z][A-Z0-9_]{2,}` 引用都必须有声明（`node --check` 抓不到的整类崩溃） |
| module boot smoke | `test:1814` | 模块 id 正确、`readSettings()` 在坏 JSON 与 v3 记录上都不抛（坏数据回落默认值） |
| sound player dedupe | `test:1836` | 冷启动首轮只记不播（armed）、同会话同类去重、1500 ms 全局节流、试听绕过前两闸、`sound.enabled:false` 不响 |
| seeded and random asset picks | `test:1899` | 图标定种哈希（同 seed 同图、seed 变重掷、多份覆盖）、`randomIndex` 边界、`pickSoundUrl` 只对 pending/error/completed 拼 URL |
| asset quotas | `test:1930` | 每类 6 份、图标 16 KB、弹出图 64 KB、音效 128 KB、2 MB 总预算按类别顺序裁剪；类型冒充被拒 |
| asset migration | `test:1965` | v4.1 单图 → `uploads[0]`、`popout.image` → `images[0]` 且 `builtin:false`、`sound.kind` → `enabled/builtin`、旧每类 `volume` → 顶层 |
| shortcut cycle and guards | `test:2025` | 三条热键按 `registerFixed` 登记（`Alt+Shift+[` / `]` / `S`，`group:'application'`）；循环只走当前 plan、当前会话不占座位；`region`/`modal`/`repeat`/`control`/`defaultPrevented` 全部放行原事件；`overlayEnabled` 关时 `S` 不被吞 |
| glyph seed ignores time | `test:2092` | 上传图标定种只依赖 `sessionId|category`：同一 seed 连渲染 5 次同图；源码里不再出现 `enteredAt` |
| shortcut edges | `test:2109` | 空 plan 不消费、单座环绕自身、跨 plan 变更时环里接着走（`a`→`b`→`c`→`a`）、缺 shift/alt 或无关 code 不消费、没有 `shortcuts` 服务时槽照常注册且热键静默 |

### 1.3 改测试时踩过的坑（照抄结论）

- **假元素必须有 `parentElement` 与 `clientWidth`**：`seatLimit()` 量的是 `[data-conversation-tabs]` 的父元素；只给 `clientWidth` 会让上限退回 6，测试看起来"座位数不对"。
- 假选择器引擎要处理 `[attr^="value"]` 时**先剥引号**，否则 `data-row-key^="session:"` 永远不匹配。
- `React.useState(initializer)` 在 stub 里必须支持**函数型初值**（设置页用 `() => snapshot()`），否则拿到的是函数而不是对象。
- `walk()` 要递归嵌套数组：`h('div', {}, arr.map(...))` 的 children 是"数组里套数组"。
- registry 是**按 slot 分键**的：`settings.section` 与 `settings.section.icon` 可以同 id，测试桩不能把它们写进同一个 Map。
- 注销是**延迟两级**（`setTimeout(0)` → rAF → `setTimeout(0)`）：断言"座位已消失"要 `await tick()`，而 `tick()` 本身要跨两个宏任务。
- 侧栏 marker 只在**有状态**的行上出现：全是 idle 且该类 `surfaces.sidebar:false` 时一个 marker 都没有，想测 marker 得给某行 `running` / `pendingInteraction`。
- **全局 `head` 是共享的**：前一组 adapter 留下的 `<style data-hotlist-style>` 会让后一组的数量断言多出来，组开头要清（`clearStyleBlocks()`）。
- **假元素要支持 `dataset` / `classList`**：浮层与侧栏都用 `dataset` 写 `data-*`、用 `classList` 标 exit 类；stub 的 `dataset` 必须写回 attributes，否则选择器查不到。
- **`matchesSelector` 要认 `.class`**：`resolvePopoutSide` 量的是 `.mP3x-q_sidebarCol`，只认属性选择器的桩会让它永远走 left。
- **必须清理副作用**：`createCtx().cleanup()` 要逆序跑完所有 `slots.inject` 的 disposer 与 `ctx.effect` 的 disposer，否则侧栏的 `setInterval` 会让 node 进程跑完 `PASS` 后不退出。

## 2. 真机（唯一能证明"真的能点"的层）

环境：test profile 的 GUI（约定端口 59559，由 profile-runner 起）。验收期间**只能一个人操作 GUI**——另一个窗口的 reload 会把你的断言打断。

### 2.1 验收脚本

- v3.1：`C:\Meru\Seek\cangku\tmp\261111_k4t_v31-acceptance.js`（7 项一把过）。
- v4.0 / v4.1（卡片设置页 + 浮层）：脚本仍待写；沿用同一命名 `cangku/tmp/261111_*_v4-*.js`。卡片 UI 的判定键是 `[data-hotlist-settings]` 与 `[data-category][data-open]`，折叠态看 `[data-hotlist-card-body]` 数，展开态点 `button.hl-cardHead`；浮层的判定键是 `[data-hotlist-popout]` / `data-hotlist-popout-cat` / `data-side` / `data-reduce-motion`，`onDone` 之后该节点必须消失。
- 用法写在文件头：`ego_script({ script: <文件内容>, timeoutMs: 118000 })`；前置是目标版本已被 profile 加载，**旧版本的结果不算数**（脚本首先断言 `window.__HOTLIST_VERSION__`）。它会产出 `OUT.summary.verdict` 与截图。
- 脚本只读 + 通过 `window.__HOTLIST_SETTINGS__` 改设置（结束还原）；唯一 DOM 改动是插一个假 `[data-dsm-dot]` 探针并删掉。不点会话、不点「允许」。

### 2.2 ego 取证的三条硬规矩

1. **视口与截图必须同一次脚本**：`setViewportSize`（或 CDP metrics）和 `page.screenshot` 分开两次调用，截图可能是旧视口——断言宽度类的用例会假过。
2. **`page.goto` 到当前 URL 不会产生新文档**：想"重载一次"必须 `page.evaluate(() => location.reload())`，否则拿到的是同一个 document，stale 的 window 状态还在。
3. **`ego_screenshot` 在脚本内不可用**：脚本里要图就用 `page.screenshot({path})`（或 CDP `Page.captureScreenshot`），事后再用 `ego_screenshot` 看是另一回事。

### 2.3 只能在真机验的清单

- 点座位是否真的切会话（`aria-selected` 在真机上不一定跟随我们，`pointerdown` 双路径就是为这个加的）。
- 注销延后是否压住了 `uiConversation.binding: unknown session`（静置 ≥60s、切换若干次后看 console）。
- 短读保护：切换后 ~70s 座位是否掉（真机历史 bug）。
- dsm 状态点顶替与还原（需要另一个插件真的在画点）。
- 动效观感：`motionTarget:'row'`、`reduceMotion`、每类的「平均间隔」——只能人眼看。
- 设置页外观：token 是否在深色主题下正确、559px 内是否横向滚动、上传真实文件时 canvas/webp 是否可用；折叠态一张卡 ≈40px、展开态「置顶」卡 ≤520px。
- `data-hotlist-settings` / `[data-hotlist-row]` 与版本标记（验收脚本靠它们一击命中）。
- 浮层：真的会在「别的会话进入 error/pending/completed」时弹出来、位置在正确一侧（auto 时看左侧会话栏宽度）、点到图上会切到那个会话、超时自己收回且收回后 DOM 里没有残留节点。
- 浮层的观感：clip 揭示的入场、breath/float 的待机、drop/particles 的退场，以及 `reduceMotion` 时是否只剩 120ms 淡入——单测只能证明属性写对了。
- 离线/缺素材时的回落：删掉某个 `assets/<cat>-<tier>.webp` 后应回落到同名 `.svg`，再删 `.svg` 应回落 emoji，console 里有 `[hotlist] popout` 的 fallback 日志。

## 3. 改动前最小回归清单

按顺序，全部过了再提"改完了"：

1. `node --check client.js index.js test/classify.test.mjs`。
2. `node C:\Meru\Seek\cangku\tmp\261111_gate_pre_restart.mjs` → `STATIC VERDICT: clean`（查未声明常量、已删字段、新字段与模块形状；`node --check` 抓不到「引用一个没人声明的常量」这类崩溃）。
3. `node test/classify.test.mjs` → `PASS — 52 groups`。
4. 如果碰了排序：断言「同一批会话只变 `updatedAt` → registry 变更数不增加」（组 `adapter plan`），否则 tab 会每 30s 抖一次。
5. 如果碰了注册/注销：断言座位 id 仍带 `hotlist-seat-` 前缀、`stop()` 后无残留节点/属性/样式（组 `adapter sidebar markers`、`surface gating`）。
6. 如果碰了 CSS：断言所有样式文本不含 `[[`，且 takeover 规则只出现在 `data-hotlist-style="takeover"` 的 `<style>` 里（组 `takeover gate`、`styles stay valid`）。
7. 如果碰了设置模型：`README.md` 的可配置项表要同步（与 `defaultSettings()` 一一对应），并跑 `settings sanitizing` + `migrate v3 to v4`；`SETTINGS_VERSION` 变了就补一条迁移与一条「旧版本安全归一化」用例。
8. 如果碰了动效：跑 `sidebar motion bursts`（并发上限、reduce 不掷、间隔 0 不掷）。
9. 如果碰了持久化：跑 `completedAt persistence`（一次 sync 只写一次、成为主视图立刻删、重启剪枝；列表 `phase` 非 `ready` 时不得丢弃读回的条目）。
10. `VERSION` 升了：`cangku/tmp/` 的验收脚本里的版本断言要同步，否则真机验收会 FAIL。
11. 如果碰了浮层：跑 `popout side resolution` / `popout priority arbitration` / `popout seq guard` / `popout reduce merge` / `popout cooldown` / `popout first entry only`；确认 `makeResolveAsset` 三条分支都不抛、`onDone` 之后节点被移除。
12. 如果碰了热键：跑 `shortcut cycle and guards`；确认没有自己挂 `document.addEventListener('keydown')`，且 `S` 只在 `shortcuts.overlayEnabled` 打开时消费事件。
13. 最后才做真机项（§2.3）。
