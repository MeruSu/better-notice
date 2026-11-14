# 热表测试指南

分两层：能在 Node 里跑的（单测，快、必须过），和只能在真机 GUI 上看的（单测替代不了）。

## 1. 单测

```powershell
cd <你的克隆目录>            # 含 client.js / index.js / test/ 的那一层
node --check client.js
node --check index.js
node --check test/classify.test.mjs
node test/classify.test.mjs       # 期望最后一行: PASS — 109 groups，exit 0
```

`node --check` 是必须的：`client.js` 是包在 `window.__ModuleLoader__.load({factory})` 里的单文件脚本，语法错只在真机 boot 时才炸。

patch 校验（js-yaml 从本机 profile 借，把 `<profile 目录>` 换成你自己的，例如 `~/.dsh/profiles/desktop/node_modules/noop.js`）：

```powershell
node --input-type=module -e "import {createRequire} from 'node:module';import fs from 'node:fs';const r=createRequire('<profile 目录>/node_modules/noop.js');console.log(JSON.stringify(r('js-yaml').load(fs.readFileSync('cordis.patch.yml','utf8'))))"
```

期望 `[{"insert":[{"id":"hotlist","name":"dsh-better-notice"}]}]`。

### 1.1 测试怎么加载真代码

`test/classify.test.mjs` 不用 import：它 stub 一个 `window.__ModuleLoader__.load` 抓住 factory，再 `new Function(source)()` 执行**真实的 client.js 源文件**，拿回模块的导出（`classify`、`sortSeats`、`buildSeatPlan`、`sanitizeSettings`、`migrateSettings`、`createSidebarAdapter`…）。所以测的是真代码，假的是浏览器环境：`document` / `localStorage` / `React` / cordis `ctx`。

### 1.2 109 组各测什么

| 组 | 位置 | 覆盖 |
| --- | --- | --- |
| heal view preferences | `test:544` | 加载时把遗留座位 id（`hotlist-seat-*` / `seat-*` / `session-switcher` / `hotlist`）的 view 偏好改回 `chat`，用户自己选的 `trajectory` 与无关键原样保留 |
| settings read/write | `test:554` | 默认值形状（`version:4`、**没有** `states`/`showIdle`/`placement`、`positions` 三键、`overlay{side,sizeMin:260,sizeMax:520,fallbackImage}` 无 `enabled`、`sound.volume`、`pinned.maxSeats:3`、`categories` 恰好 **6 个键**、`idle.surfaces.tab` **true**）；越界归一（`maxSeats:40→12`、`pinned.maxSeats:99→12`）；v3 扁平补丁（`showIdle` / `completedTtlMs` / `states.approval` / `states.question`）落到对应类别；`resetSettings()` 回默认 |
| migrate v3 to v4 | `test:593` | v3 逐项迁移：`approval→pending.glyph`、`question→pending.glyphSecondary`、`plan-review`/`subagents` 丢弃、`running.motion` 保留；v3 内联图 → `glyph.uploads[0]`（名 `legacy`）且 `source:'upload'`、`value` 回类别默认 `✅`；`overlay.scale:4` 倍数 → `sizeMin:260`/`sizeMax:900`、`customImage→fallbackImage`、`shortcut→shortcuts.overlayKey`、`overlay.enabled:true` → `pending/error/running` 三类 `popout.enabled`；写回后 `states`/`glyphs`/`motion`/`placement` 一个不留，二次读与首次一致 |
| current version keeps custom order | `test:657` | 已是 v4 的记录原样保留用户改过的 `categories.error.order:5` 与 `idle.enabled`，不再走迁移 |
| alpha version 5 normalizes safely | `test:673` | alpha 工件的 `version:5` 安全归一成 `4`，保留它写下的 `categories.error.order`，其余回默认 |
| bad data falls back | `test:688` | 逐字段回落：`version:'five'→4`、`maxSeats:'many'→6`、`positions.tab:'yes'→true`、`overlay.side:'up'→auto`、`scale:99→sizeMax:900`、svg `fallbackImage→''`、TTL `-5→60000`、`pinned.maxSeats:400→12`、`pending.order:500→99`、`kind:'animated'→emoji`（`value` 保留 `x.gif`、`uploads` 清空）、超 8 字 emoji → `''`；未知类 `nope` 与已退役的 `favorite` 都不进 `settings.categories`，保留键里也不留 `categories.favorite` |
| seven categories | `test:729` | **6 类**各出一行（`pinned:pinned`/`pending:approval`/`error:error`/`completed:completed`/`running:running`/`idle:idle`），置顶来自宿主 `pinnedSessionIds`；`idle` 是窗口：正好 5 分钟收、多 1ms 不收 |
| pending merge and subagents | `test:791` | `approval`/`question`/`plan-review` 三态归 `pending`（token 分别 `approval`/`question`/`question`）；父会话有子代理在跑 → `running:running`；pending 共 3 行 |
| pinned follows the configured order | `test:822` | 在 `surface:'sidebar'` 下用宿主置顶列表 `['s1','s3']`：**默认** `pinned.order=60` 排在 `idle(50)` 之后，所以两个置顶会话都判成 `idle`（座位 order `5001/5002`、token `idle`），只有 running 的 `s2` 是 `3001`；把 `categories.pinned.order` 调成 5 后同一批会话变成 `pinned`（order `501/502`，按置顶列表顺序），`s2` 仍是 `3001 running` |
| category order | `test:854` | `error.order=5`、`pending.order=20` → 座位 order 变 `501`/`2001`，展示顺序跟着 `categories.<id>.order` 走 |
| plan limit and current session | `test:876` | 非紧急类按 `limit` 截断、紧急类（`error`/`pending`）照常出座：`limit:2` → 类别序列 `error,error,pending,running,running`、`plan.overflow===1`；`currentId` 指定的当前会话不占座位 |
| urgent overflow hard cap | `test:908` | 紧急类不受 `limit` 限但受 `limit + ALWAYS_OVERFLOW(4)` 硬顶：`limit:1` + 7 个 pending → 5 座（`p1`…`p5`）、`plan.overflow===2` |
| surface gating | `test:926` | 每类 `surfaces.tab`/`surfaces.sidebar` 单独生效（`idle.surfaces.tab:false` 后 tab 只剩 running，侧栏仍有 idle）；`positions` 全关 → `allPositionsOff===true` 且 `surfaceVisible===false` |
| idle third tier on the tab row | `test:969` | 默认 `idle.surfaces.tab===true` + `collect.recentWindowMinutes===5`：窗口内普通会话在 `surface:'tab'` 下产出 `idle` 行；窗口 0 不产出；`idle.surfaces.tab:false` 不产出 |
| labels | `test:987` | `labelOf`：token 的 emoji + 标题（`🔐 写入工作区外审批` / `❓ 选一个`），无标题用「未命名会话」；`glyph.kind:'img'` 时 tab label 回落该类别 emoji |
| sidebar priority | `test:998` | `sidebarStateOf` 优先级：`approval`/`question`（`plan-review` 折成 question）/`running`/`completed`/`error` 都压过 `pinned`，**只有 `idle` 排在置顶之后**；`running.surfaces.sidebar:false` 时退回 `idle`；超窗口的老会话 → `null` |
| settings sanitizing | `test:1031` | `sanitizeSettings` 纯函数容错：`maxSeats:'auto'` 保留、gif 收、svg 拒（回落 emoji 且 `value:''`）、`popout.displayMs:123456→20000`、`entrance:'nope'→slide`、`sound.kind` 不保留（只留 `enabled`/`builtin`/`uploads`）、`sound.volume:400→100`、`recentWindowMinutes:500→120`、`motion:'wiggle'→bounce`、v3 `overlay.scale` 无对应（`sizeMin/sizeMax` 回默认）、`overlay` 里没有 `enabled`、`categories.pinned.order` 默认 **15**（不再是强制的 0） |
| settings surface | `test:1075` | `window.__HOTLIST_SETTINGS__.get()` 可用、`override()` 测试缝（9 / 恢复 6 回默认）；旧的 `dsh.session-switcher.settings`（`version:3`）被读走且旧键删除，`resetSettings()` 也会清掉它 |
| adapter plan | `test:1095` | tab 适配器整体（async）：座位 order `[['s2',3001],['s1',5001]]`、通过公开 settings 面关掉 `running.surfaces.tab` 两轮内少一座、再开回来恢复；点座位切会话（mount 与 pointer 双路径，`opened` 去重后只有 `s1`、视图回 `chat`）；`openSession` 拒收时把消息写进 state 而不抛 |
| adapter sidebar markers | `test:1157` | marker 插在标题前、`data-hotlist-char` 是当前状态图标（🔐 / ⏳）、`data-hotlist-hide-native` 落在行上、`refresh()` 后仍只有一个 marker、`stop()` 把 marker 与行属性全还原 |
| adapter sidebar pinned and children | `test:1194` | 侧栏看到与 tab 一样的信息：置顶会话出 📌、有子会话在跑时父会话出 ⏳ |
| takeover gate | `test:1226` | `takeOverStatusDot:true` 时 `[data-hotlist-style="takeover"]` 恰好 1 个且 dsm 点 `display:none`；改成 `false` 后 style 块被移除、点的 inline `display` 还原成 `''` |
| styles stay valid | `test:1257` | 所有注入的样式文本不含 `[[`（二次包裹的选择器），`stop()` 后 `[data-hotlist-style]` 一个不剩 |
| settings page | `test:1293` | section 注册 `[['hotlist',30]]`、label「热表」、页根 `data-hotlist-settings="v5.2.0"`；全局区行键齐（`maxSeats`/`pinned.maxSeats`/`collect.completedTtlMs`/`sound.volume`/`recentWindow`/`positions.tab`/`positions.topbar`/`takeOverStatusDot`）；**6 张卡**按 order 排 `error,pending,pinned,completed,running,idle`；折叠态 **30 个 chip**（6×5，其中 6 个是 topbar 位：`data-disabled="true"` + `data-on="false"`，位置 chip 的 `title` 是 `settings.chip.positionHint`）；`hideNativeDot`/`shortcuts.*`/`reset`/`within`/`overlay.size` 五类行**不存在**；`categories.favorite` **不存在**；`window.__HOTLIST__.assets.add(...,'nope',...)` 返回 `reason:'invalid'` |
| settings page card order | `test:1362` | 改 `categories.error.order = 5` 后卡片顺序是 `error,pending,pinned…`（error 与 pending 同为 10，按 `CATEGORY_ORDER` 兜底），末位 `idle` |
| settings page overflow notice | `test:1376` | v4.4 删掉了提示条：`publishOverflow`/`currentOverflow`/`onOverflowChange` 都不再导出、页面无 `[data-hotlist-overflow]`、文案里没有 `settings.overflow`；但 `plan.overflow` 的数字仍在（`limit:1` + 3 行 → `overflow===2`） |
| settings upload gate | `test:1397` | `glyphUploadReject`：`null`→`missing`、svg→`type`、**gif 放行**、webp 5 MB→`size`；超限 data URL 在 `sanitizeSettings` 里回落 `emoji` 且 `value:''`。上传是**两道闸**：源文件大小与产物（重编码后）大小 |
| settings reset drops legacy keys | `test:1410` | 盘上写入带 `states`/`glyphs`/`motion`/`placement`/`showIdle` 的记录后 `resetSettings()`：存储是 `version:4`、`maxSeats:6`，旧键一个不留 |
| settings maxSeats applies at once | `test:1432` | （async）`writeSettings({maxSeats:2})` 后两轮 `tick()` 座位数 3 → 2，改回 6 恢复 3（两级延迟注销） |
| popout side resolution | `test:1478` | `resolvePopoutSide`：`left`/`right` 直通；`auto` 量左侧会话栏（量不到或塌陷 → `left`，够宽 → `right`）；配套 `tierFor`（260→320、780→1560）、`assetRef`/`fallbackRef`（`plugins/dsh-better-notice/assets/error-320.webp` 与 `error.svg`）、`dropDistance` |
| popout priority arbitration | `test:1505` | 单槽抢占：`completed` 弹后 `pending` 抢占、`error` 再抢占；低优先遇到高优先**直接丢弃不排队**；同级换会话 |
| popout seq guard | `test:1521` | 旧 `displayMs` 定时器回调不能关掉新浮层（单调 `seq` 比对） |
| popout reduce merge | `test:1554` | `display.reduceMotion:'on'` 与系统偏好合并成 `isReduced`：`data-reduce-motion="1"`、`--hl-enter-ms:120ms`、退场固定 `fade`（`exit-fade` 有、`exit-drop` 无）；系统偏好为假时 `data-reduce-motion="0"` |
| popout cooldown | `test:1576` | 同会话同类别 10 s 冷却（9999 ms 拒、10001 ms 放行）；另一个会话是不同的键，不受冷却 |
| popout first entry only | `test:1588` | 只在会话**首次进入**类别时弹：一直 `pending` 不重弹；当前会话不弹；换类别且冷却已过才弹；`error` 压过它替换掉的 `pending` |
| overlay size sanitising | `test:1621` | `overlay.sizeMin/sizeMax`：越界夹到 120–900、`min>max` 自动交换（200/900）、缺省回落默认。**v4.5 只删了设置页那一行，schema 与算法照旧，这一组仍要跑** |
| playback frequency sanitising | `test:1636` | `glyph.frequency`：`0→0`、`0.42→0.4`（0.05 步进）、`0.65` 原样（不是预设就是选择）；**`1` 与越界的 `9` 都落回 `pending` 的当前默认 `0.9`**（`1` 是 v4.4 出厂预设）；旧 `motionIntervalMs` 换算（`2000→1`、`8000→0.9`、`60000→0`，**`0` 仍是 0 而不是 1**）且换算后旧字段不写回；旧的全局 interval 分发到各含该字段的位置（`0.5`） |
| glyph source resolution | `test:1670` | `glyph.source` 三态：`upload` 用 data URL、`popout` 用该类别弹出图（`builtin:<cat>` 解析成打包素材）、`emoji` 用文本；空 emoji 回落类别内置图标 |
| sidebar motion bursts | `test:1705` | 每类每 tick 恰好一次 `Math.random()`：3 个 100% 类 → 3 次掷骰、3 个 burst；`reduceMotion:on` 全停但仍不掷；`frequency:0` 跳过掷骰；5% + roll 0.9 不中、roll 0.02 中；并发上限内 |
| settings page multiple open cards | `test:1772` | `sessionStorage['dsh.hotlist.open']` 存 JSON 数组：多张卡同开、未知 id 被过滤、旧版本写的裸字符串按单元素数组读 |
| settings page densified rows | `test:1799` | 展开态排版：`.hl-rowMulti` 的 `--hl-cols` 同时出现 `3`（弹出/动效组）与 `2`（图标来源/尺寸）、`.hl-cell` ≥10；全局区有 `recentWindow` 且**没有** `within`；**没有** `overlay.size`、**没有** `positions.sidebar`、**没有** `categories.favorite`；`popout.entrance` 是只读文本，6 张卡各一条 `settings.popout.entranceFixed` 提示 |
| settings page has no reset row | `test:1833` | v4.4 删掉「恢复默认」行：没有 `reset` 行、没有 `[data-hotlist-reset]`；但 `__HOTLIST_SETTINGS__.reset()` 仍能写回默认（API 保留） |
| completedAt persistence | `test:1852` | （async）`✅` 时间落盘：同一轮两个会话完成只写一次、成为主视图立刻删除并落盘（第二次写不等节流）、重启后按 TTL 与工作区剪枝；列表 `phase` 还是 `pending` 时一律不剪枝（reload 不得把读回的条目写成空），`ready` 后不存在的会话才剪 |
| no undefined constants | `test:1946` | 静态扫描：剥掉注释/字符串后，任何 `[A-Z][A-Z0-9_]{2,}` 引用都必须有声明（`node --check` 抓不到的整类崩溃，2026-11-11 真出过一次） |
| module boot smoke | `test:1968` | 模块 id 是 `dsh-better-notice`；`readSettings()` 在坏 JSON 上回落默认（`version:4`、`maxSeats` 默认）、v3 记录上安全迁移（`overlay.sizeMin/sizeMax` 260/520）都不抛 |
| sound player dedupe | `test:1990` | 冷启动首轮只记不播（armed）、同会话同类是重绘不响、离开再进入响一次（`/hotlist-sound/attention.wav`、`volume 0.6` 来自全局 60）、1.5 s 内第二声静音并记日志、试听绕过前两闸、`enabled:false` 的类不响、无内置也无上传时 `pickSoundUrl` 返回 `''` |
| seeded and random asset picks | `test:2053` | 图标定种哈希（同 seed 同下标、不同 seed 分散）、`randomIndex` 边界（1→0、5→4）、`pickSoundUrl` 只对 pending/error/completed 拼 URL（`BUILTIN_SOUND` 形状）、`pickPopoutArt` 三态（内置/上传 data/emoji） |
| asset quotas | `test:2088` | 每池 6 份（第 7 份被拒、保留最早的）、图标 16 KB、弹出图 64 KB、音效 128 KB、2 MB 总预算按类别顺序裁剪（先删音效再动图片）；图片冒充音效被拒；空名补成 `glyph-1` |
| asset migration | `test:2123` | v4.1 单图 → `glyph.uploads[0]` 并 `source:'upload'`、`popout.image` → `images[0]` 且 `builtin:false`、`sound.kind:'builtin'` → `builtin:true`、旧每类 `volume` → 顶层 `sound.volume` |
| shortcut cycle and guards | `test:2147` | 三条热键按 `registerFixed` 登记（`{code, modifiers:['alt','shift']}`、`group:'application'`）；循环只走当前 plan、当前会话不占座位；`region`/`modal`/`repeat`/`control`/`defaultPrevented` 全部放行原事件；`shortcuts.overlayEnabled` 关时 `KeyS` 不被吞 |
| glyph seed ignores time | `test:2214` | 上传图标定种只依赖 `sessionId|category`：同一 seed 连渲染 5 次同图、`kind` 仍是 `img`；源码里不再出现 `enteredAt` |
| shortcut edges | `test:2230` | 空 plan 不消费任何键；单座环绕自身；多座 `a→b→c→a` 回绕；缺 shift 或缺 alt 不消费、无关 code 忽略；没有 `shortcuts` 服务时热键注册数为 0 而座位照常注册 |
| shortcut labels are thunks | `test:2293` | 三条 `registerFixed` 命令的 `label` 是**惰性 thunk**（`typeof label === 'function'`、调用返回非空字符串），id 与 `bindings[0].code` 是 `hotlist.cycle.prev/next/overlay.once` ↔ `BracketLeft`/`BracketRight`/`KeyS` |
| recent window migration and clamping | `test:2318` | 全局 `collect.recentWindowMinutes`：旧每类 `within:30` 迁到顶层且类字段不再存在、旧默认 `5` 走 5、显式值优先、`500` 夹到 120、`-4` 夹到 0；0 时 idle 一行都不产出 |
| preview loop lifecycle | `test:2344` | 预览按频率常驻循环。这一组用 `completed`（`blink` 与频率 `1` 是 v4.4 出厂预设，v5.0.0-alpha.1 会替换它们，拿 `pending`+`blink` 测不出常驻）：100% → `hl-pv-spin-20 2400ms linear infinite`、50% → `hl-pv-spin-10 4800ms linear infinite`、0 或 `reduceMotion:on` → 没有 `animation` |
| motion target row reaches the title | `test:2383` | `motionTarget:'row'` 真的动到标题：标题拿到 `hl-text-blink 1.2s ease-in-out 1` 与 `data-hotlist-text-motion`，行上同时有 1 个 `[data-hotlist-burst]`；样式表里 `@keyframes hl-text-bounce` 含 `translateY`（不再只动 opacity） |
| settings page writes land immediately | `test:2421` | 页面控件写的是同一个 store：数字框/复选框 `onChange` 后 `readSettings()` 立刻反映（`recentWindow:30`、`maxSeats:1`、`positions.tab:false`），座位类改动两轮 `tick()` 内 tab 行跟着变（3 → 1 → 0） |
| plan hard ceiling keeps the priority head | `test:2476` | 硬顶 37 行（`PLAN_MAX_ROWS`）：60 个 idle + `limit:40` → 恰好 37 行、`overflow===20`；加入 1 个 error 后 `plan[0].category==='error'`、被挤掉的是尾部 `idle-36`、头部 `idle-0` 还在 |
| defaults never overwrite stored values | `test:2508` | 改默认值不等于改用户设置：所有类别默认 `glyph.motionTarget` 是 `'row'`；盘上存了 `pulse` + `frequency:0.35` 时 sanitize 原样保留（两者都不是任何一代预设；`'glyph'` 与 `1` 属于旧预设，归下一组管） |
| user settings are never overwritten | `test:2537` | 本版表示不了的也保留：`maxSeats:40` 活动值夹到 12，但**原始 40 与未知键 `experimental` 都留在保留键里**（`outOfRange.maxSeats={raw:40,clamped:12}`）；写入旧整块进 backup 环（1 条、`version:4`） |
| legacy default order is adopted, real choices are kept | `test:2571` | 逐类判断「等于历史默认就算没选过」：`pinned 1→15`、`pending 20→10`、`completed 30→20`、`running 40→30`；用户真填的 `42`/`7`/`60` 一概不动（`idle` 从没有旧默认，60 就是用户输入）；整块老 blob 里 `pinned 0→15`、`error 10` 不变 |
| recent window UI bounds match the API | `test:2600` | 两层范围且 UI 不再收窄：设置页 recentWindow 数字框 `min===1`、`max===120`（与存储层同界）；随后 `writeSettings({collect:{recentWindowMinutes:90}})` 之后 `readSettings()` 与盘上都是 **90** —— 页面只是入口，不是数据上限 |
| defaults for v4.6.3 | `test:2627` | 六类出厂预设表：`pinned/error/pending` 动效 `bounce`、`completed/running` `spin`、`idle` `none`；频率 `0.3 / 0.9 / 0.9 / 1 / 1 / 0`；`motionTarget` 六类全 `'row'`；音效默认 `error/pending/pinned/completed` 开、`running/idle` 关；`idle` 图标是 `🧊`、`sound.volume` 60 |
| factory presets are replaced, user choices are kept | `test:2656` | 另一半规则（出厂预设不是选择）：一份 v4.6.3 写出的存档里 `💤`→`🧊`、`blink`/`none`→`bounce`/`spin`、`motionTarget` 的 `glyph`→`row`、`frequency:1`→该类默认、音效 `false`→四个响类的默认 `true`；用户真改的值（`🌙`、`pulse`、`0.15`、`true`、order `7`）一个都不动；两个 glyph 槽各有自己的表（`none` 只在主槽是预设，在副槽是选择）；同一份输入再喂一遍结果逐字节相等 |
| user picks survive the preset rule | `test:2742` | v5.0.0-alpha.1 的 `choices` 标记：`writeSettings({categories:{error:{sound:{enabled:false}}}})` 之后读回来仍是 `false`（旧版会回弹成 `true`），`choices` 里正好一条 `categories.error.sound.enabled`；`none` / `blink` / `glyph` / 频率 `1` / `💤` 这些与旧预设同值的选项都能落地；只标了 `motion` 时邻居 `motionTarget` 仍跟随 `row`；`backups()`/`restore(0)` 连标记一起回滚；`resetSettings()` 后 `choices` 为空且预设重新生效；二次 sanitize 逐字节相等；`sanitizeChoices` 丢弃 `false`、非法形状与超长键 |
| topbar band coexists with the tab row | `test:2870` | 顶栏与 tab 行**并存**：同一个 ctx 里 `hotlist.topbar` 与 `hotlist-seat-*` 同时注册，谁都不顶替谁；顺带验证模块加载时把遗留座位 id 的 view 修回 `chat` |
| topbar needs the desktop strip or an explicit preview | `test:2943` | `positions.topbar` 默认 `true` 但浏览器里不画：没 `data-windows-titlebar` 又不给 `topbar.previewInWeb` 时 band 不挂载；`mode:'chips'`、`rightReservePx:0` 是默认 |
| topbar overflow counts pills and +N walks the hidden ones | `test:2998` | 胶囊量宽与折叠：`chipWidthOf('')===72`（下限）、`'abcd'===72`（24+4×12 恰好）、`'abcdefgh'===120`、40 字符与 10 个 emoji 都封顶 `140`；`fitChipCount([72,72],100)===1`（要给 `+N` 留 44）、`([72,72,72,72,72],400)===5`、`(…,300)===3` |
| topbar settings are clamped | `test:3085` | `topbar` 归一化：未知 `mode`、非布尔 `previewInWeb`、`rightReservePx:9999→400`、`-20→0` 全部回落；`mode:'count'` 保留 |
| topbar pills have no frame and skip the current session | `test:3111` | 胶囊不画外框（背景与边框留空，只有文字与图标），且当前会话不占胶囊——顶栏只提示「别的会话」 |
| category topbar switch decides who shows | `test:3160` | 每类 `surfaces.topbar` 单独开关：关掉某类，它立刻从 band 消失但 tab 行不受影响；`running` 无论如何都不进 band |
| pill width follows the setting | `test:3193` | `topbar.chipWidthPct` 是百分比不是像素：`0` 与旧版逐字节一致（72/140 两界不变）；`-30` → `72*0.7=50`、40 字符 `140*0.7=98`；`+30` 反向变宽 |
| icon can be emptied and each category resets on its own | `test:3220` | 图标可清空：`kind:'emoji'` 值 1/2 码点收、**3 码点拒成 `''`**；`kind:'none'`+`value:''` 是「明确清空」，读图标时任何来源都不再回落；每类「重置这一类」只回滚该类 |
| four new settings fields default and clamp | `test:3285` | 四个新字段：`scope:'smart'`、`positions.topbar:true`、`topbar.titleMode:'custom'`、`topbar.maxSeats:6`，且 `version` **仍是 4**（走默认值分支，没升版）；`sanitizeSettings({scope:'nope'})` 回 `'smart'` |
| scope persists across a reload | `test:3315` | `scope` 三值逐轮写盘再读回都一致、经一次 sanitize 也不变；写 `scope` **不动**盘上的 `positions.topbar`（两件事互不覆盖） |
| scope three-way semantics | `test:3328` | `scope` 三档语义：`workspace` 只留当前工作区（`out-1` 被裁）；`all` 全工作区且**跨工作区置顶仍是 pinned**；`smart` 会话本身仍在，但**跨工作区置顶被降级成 idle** |
| titleMode reaches the pills | `test:3402` | 三档真的画到胶囊：`custom` 与 `icon` 都有 emoji 列（每颗 1 个）+ 1 个标题段；`text` 的 emoji 列归零而标题段仍在；band 节点带 `data-hotlist-title-mode`；`window.__HOTLIST__.topbar().titleMode` 报的是实时值 |
| settings page shows the new rows | `test:3440` | 页面按 `positions.topbar` 决定 band 段去留：开着时 `scope`/`topbar.titleMode`/`topbar.maxSeats` 三行都在；关掉后只剩 `scope`（它是全局行，永不消失） |
| console export defers to explicit ids | `test:3477` | 导出**只听 ids**：显式给 `ids:['a']` 时 JSON 解析成长度 1 的数组，页面上的 scope / 当前会话都不参与决定导谁 |
| session export is deterministic and safe to call bare | `test:3492` | 导出裸调用不抛：`exportSessions()` 返回 Markdown 字符串、以 `\uFEFF` 开头（BOM，Notion 粘贴中文不乱码）、表头是 `\uFEFF| displayTitle |`；标题里的 `|`、`\t`、`\n` 被安全处理；同一输入两次输出逐字节相等 |
| every seat count uses the same stepper | `test:3584` | 六个数字行共用同一个 stepper：`maxSeats`/`pinned.maxSeats`/`topbar.maxSeats`/`collect.completedTtlMs`/`sound.volume`/`recentWindow` 每个都有 1 个 `data-hotlist-stepper`、`['minus','plus']` 两颗按钮与同一个 `hl-input hl-num` 值框 |
| the band takes the urgent classes and the tab row the background ones | `test:3607` | 分工靠 `surface` 参数：`buildSeatPlan({surface:'topbar'})` 只收 `error/pending/completed`，`surface:'tab'` 只收 `pinned/idle`，`running` 两边都没有 |
| the band mounts with pills next to the tab row | `test:3632` | 真挂载：`previewInWeb:true` 时 `window.__HOTLIST__.topbar()` 报 `mounted:true`、`chips:[{id:'pv-ask'}]`（只有 pending 那颗），band 里真画出 1 颗胶囊，而 idle 会话的 `hotlist-seat-pv-idle` 仍在——两个面同时存在 |
| label modes draw exactly one emoji | `test:3663` | 一个 emoji，绝不两个：`leadingEmoji('✏️UI 大师')==='✏️'`、没有 emoji 时 `''`、空输入 `''`；`stripLeadingEmoji` 剥后是 `'UI 大师'`；三档与 scope 组合下 `labelOf` 只出现一颗 emoji |
| label mode names and their aliases | `test:3704` | 三档正名与别名：`TOPBAR_TITLE_MODES===['text','icon','custom']`；`TITLE_MODE_ALIASES==={unified:'text',two:'icon',smart:'custom',auto:'icon'}`；四个旧名经 sanitize 都落到对应新名 |
| custom scope decides per category | `test:3721` | `customScope` 逐类生效：关掉 `idle` 后 idle 座位拿到类别图标 `🧊 大聪明`，而 `pinned` 座位仍用标题自带的 `🎓 大聪明`；六类可以同时全关 |
| the scope row only exists in custom mode | `test:3741` | scope 行只在 `custom` 档出现：`custom` 时页面有 6 颗 `data-hotlist-scope` chip；换成 `text` 或 `icon` 时整行归零（那时候它不起作用） |
| pills strip the title emoji the same way | `test:3772` | 胶囊与座位同一套规则：`icon` 档 emoji 列是类别图标 `🧊`、标题段为 `大聪明`（标题自带 🎓 被剥）；`custom` 档 emoji 列消失、标题段变回 `🎓 大聪明`；把 idle 移出 scope 后类别图标又回来 |
| the band never starts under the menu | `test:3811` | 左边界是**命中测试**不是估算：`elementsFromPoint` 命中一块 right=262 的元素时 `occupiedLeft()===270`、`bandLeft()===270`、`leftSource()==='occupied'`；全宽容器（left 280 / right 1844）**不算**占位，不会被当成左边界 |
| label mode labels name what they draw | `test:3845` | 三档的中英文案名副其实：`settings.topbar.titleMode`「标签显示设置」、`.text`「仅显示文本」、`.icon`「使用插件图标」、`.custom`「自定义显示图标」、`settings.topbar.customScope`「自定义生效范围」；旧键 `.unified/.two/.smart` 已删不重复；英文侧 `Label display` / `Text only` 也在 |
| settings page reads as one page | `test:3865` | 整页读起来是一页：`scope` 行排在 `maxSeats` **之前**；`topbar.mode` 与 `topbar.rightReservePx` 两行**已删**（字段留给 API）；三个数字行同样共用 stepper；胶囊宽度 `0%` 显示成「默认」而不是数字；`WINDOW_CONTROLS_GUARD = 138` 写死在代码里且 band 宽度算式减掉它；三个座位上限的 hint 措辞是一家人 |
| a failure outlives the running flag | `test:3904` | 失败态活过 running：源码里**不再有**「每轮 sync 见到 `running===true` 就 `errors.delete(id)`」的急切擦除；改为订阅 `ctx.remote.$on('api-session/activity'`，只有出现更新的用户消息才退休错误标记（TTL 兜底） |
| sidebar row titles follow the same label modes | `test:3923` | 侧栏行标题走同一套三档：`icon` 档侧栏行首是类别图标、标题里的 emoji 被剥；`text` 档只留文字；`custom` 档让标题自带 emoji 顶上——侧栏与 tab 行/胶囊三处不出现两种规则 |
| the table names every seat and why the rest are out | `test:3971` | `hotlistTable()` 的 `rows` 每行带 `surfaces`（哪个面在画它）与从 1 开始的 `index`；`missing` 逐条给原因 —— 超上限 `over-cap`、该面关着 `position-off`、空会话 `empty`、子代理 `subagent`；把 idle 的三个面全关后原因变 `surface-off`；`scope:'workspace'` 时别的工作区会话原因 `scope`；`table.limit` 随行带出供标题使用 |
| the table view is a tab of its own | `test:4025` | 看板以固定 id `TABLE_VIEW_ID` 注册、`order === TABLE_VIEW_ORDER`（排在所有座位之后）；组件渲染出一个 `data-hotlist-table` 根节点、每个热会话一行 `data-hotlist-table-row`，此处没有落选行所以 `data-hotlist-missing` 计数为 0 |
| pills carry the class animation | `test:4051` | 顶栏胶囊带类别动效：待审批会话的胶囊有 `data-hotlist-chip-motion='bounce'`；把 `display.reduceMotion` 改成 `'on'` 后重渲染，该属性变 `undefined` —— 减动效摘掉的是胶囊上的动效，不是不画胶囊 |
| tab seats draw the same glyph and motion | `test:4078` | 把 `categories.pinned.order` 调到 5 让会话进 tab 行后，座位按钮里长出 `data-hotlist-tab-glyph` 的 span：文本是类别图标 `📌`、`data-hotlist-motion='bounce'`；宿主原来的文本节点仍是 `会话 tab-pin` —— 图标不写进标题文字 |
| every category offers all three positions | `test:4108` | 六类 × `tab`/`sidebar`/`topbar` 共 18 个 `categories.<类>.surfaces.<面>` 行全部存在；`idle.surfaces.tab` 初始 `checked:true`，触发 `onChange()` 后设置里变 `false`，重渲染时摘要行那颗 `tab` chip 跟着变 `data-on='false'` —— 行与 chip 读的是同一份设置 |
| export is an API, not a button | `test:4143` | 设置页里**没有** `data-hotlist-export` 节点、也没有任何行键含 `export`；但 `window.__HOTLIST__.export` 仍然是函数，`export({format:'json'})` 返回可 `JSON.parse` 的数组 —— 导出只从控制台走 |
| a yielded title still shows a class glyph | `test:4158` | 标题自带 `🎓` 时侧栏仍建出 `data-hotlist-glyph` 槽位：`data-hotlist-char='🎓'`（用标题那颗而不是类别图标）、`data-hotlist-glyph-kind='emoji'`（所以能挂动效）、`style.display` 不是 `none`；同时宿主标题文本里那颗 emoji 被剥掉，只剩 `大聪明` |
| equal order falls back to the class rank | `test:4190` | `error.order` 与 `pending.order` 同为 10、同一会话既报错又待审批时，`classify()` 判成 `error` —— 平手靠类别名次（`CATEGORY_RANK`）断，不靠 Map 插入顺序 |
| the table only reads the surfaces that are on | `test:4204` | 三个面全开时该行 `surfaces` 三项全 `true`、`missing` 为空；band 落下（`bandUp:false`）且只开 tab 时 `surfaces` 变 `{tab:true,sidebar:false,topbar:false}` 但仍有一行；三个面全关时 `rows` 为空，而该会话进 `missing` 且 `reason==='position-off'` —— 不是悄悄消失 |
| the table keeps a foreign pin out of the pinned class | `test:4239` | `scopeWorkspaceIds:['here']` 时别的会话的置顶不算置顶：行还在，但类别落 `idle`；把它划进本工作区、`pinned.order` 仍是默认 60 时还是 `idle`（置顶默认比 idle 弱）；只有把 `pinned.order` 提到 5，本工作区的置顶才变 `pinned`，而别的工作区那颗**无论 order 多高都不赢** |
| a slot declared later never gets registered early | `test:4265` | 宿主先声明 `shell.overlay`、后声明 `conversation.view`：`apply()` 后顶栏进它自己的槽（`hotlist.topbar` 已注册），但**没有任何 `hotlist-seat-*`、也没有 `hotlist-table`**；等到 `conversation.view` 被声明，座位与看板才注册 —— 这就是 5.0.0-alpha.1 那次 `slot "conversation.view" is not declared` 启动崩的回归位 |
| rows left out are grouped by reason, not dumped | `test:4294` | 落选行按固定阅读顺序分组成 `['over-cap','empty','subagent']`（不是按条数排名）；每组是一个 `<details>` 且默认折叠（`open===undefined`）；三个落选会话仍然都渲染在组里、各自带原 `data-hotlist-missing` 原因；每组头部 `hl-missingGroupCount` 报该组条数（此处三个 1） |
| the cap has no auto mode and the window default replaces the old one | `test:4343` | `maxSeats` 行只剩 `[minus, plus]` 两个 stepper、没有第二个 `aria-pressed` 控件（自动档按钮已删）；`sanitizeSettings({maxSeats:6, collect:{recentWindowMinutes:5}})` 把未标记的 5 认成旧出厂默认、升到 **17**，而经页面写过的 5 会被记成用户选择、重载后仍是 5；`maxSeats:'auto'` 仍然合法（只是没有按钮），`buildSeatPlan` 按传进来的 `limit` 截断 |
| display metadata: the plugin list can show a name and an icon | `test:4382` | 插件列表的元数据：`package.json` 的 `icon` 指向 `./icon.svg` 且 `exports['./icon']` 与 `exports['./locale/*.json']` 都在、`files` 含 `icon.svg` 与 `locale`；`locale/{en,zh}.json` 两种语言的 `meta.title`/`meta.description` 都非空；图标以 `<svg` 开头且 ≤256 KiB（宿主上限） |
| ring player: off by default, one ring per entry when switched on | `test:4402` | 光圈默认全关（`ring.pending/error/completed` 都是 `false`，且不是 `choices` 里的用户选择）；开了以后同一个会话只在**进入**该类的那一次升一圈（同一类连续两次 sync 只一次）；`running`/`idle` 甚至不在 `RING_CATEGORIES` 里；1500 ms 节流共享 |
| host ring: script arguments and no-pwsh safety | `test:4472` | 宿主半边三道闸：参数夹取（`seconds` 夹到 1–30、`scope`/`anim` 白名单）、`spawn` 必须挂 `child.on('error')`（不挂会打死 host）、脚本真的在包里（`files` 含 `tools/attn-ring` 且**不含** `tools`）且在磁盘上（`RING_SCRIPT` 可解析） |

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

- v3.1：`cangku/tmp/261111_k4t_v31-acceptance.js`（7 项一把过；`cangku/` 是作者本机的草稿区，不在仓库里）。
- v4.0–v4.4：实测脚本在 `cangku/tmp/261111_v41_delta_out.json`（37 项）与 `cangku/tmp/261111_ev3*_out.json`（持久化），命名沿用 `cangku/tmp/261111_*_v4*.js`。卡片 UI 的判定键是 `[data-hotlist-settings]` 与 `[data-category][data-open]`，折叠态看 `[data-hotlist-card-body]` 数，展开态点 `button.hl-cardHead`；浮层的判定键是 `[data-hotlist-popout]` / `data-hotlist-popout-cat` / `data-side` / `data-reduce-motion`，`onDone` 之后该节点必须消失。
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
- 动效观感：`motionTarget:'row'`、`reduceMotion`、每类的「播放频率」（0–100% 滑块）与常驻预览——只能人眼看；`row` 目标现在带 1–2px 位移，标题应该看得出在动。
- 设置页外观：token 是否在深色主题下正确、559px 内是否横向滚动、上传真实文件时 canvas/webp 是否可用；折叠态一张卡 ≈44px、展开态「置顶」卡 ≤520px（v4.4 真机：44 / 514 / 466；v4.5 少了全局区一行与 i18n 两键，v4.6.2 又删掉了「收藏」整类，卡片只剩 6 张，整体只会更矮）。
- 设置页结构与版本标记（验收脚本靠它们一击命中）：页根 `data-hotlist-settings` 期望值是 **`v5.2.0`**；卡片 **6 张**（`error` / `pending` / `pinned` / `completed` / `running` / `idle`，4.6.2 起「收藏」整类已删）；折叠态 chip 共 **30 个**（6 卡 × 5），其中 6 个是 topbar 位（`data-disabled="true"` + `data-on="false"`）；全局区 8 行 `[data-hotlist-row]` = `maxSeats` / `pinned.maxSeats` / `collect.completedTtlMs` / `sound.volume` / `recentWindow` / `positions.tab` / `positions.topbar` / `takeOverStatusDot`。
- 置顶走宿主原生：置顶来自宿主快照 `pinnedSessionIds`（侧栏行 hover 的「置顶会话」按钮），`settings.pins` 已在 **4.6.0 废弃**、读时丢弃，设置页也没有上移/下移/取消置顶；插件只提供全局「置顶最多显示」`pinned.maxSeats`（0–12，默认 3，0 = 不显示置顶）。真机上置顶/取消置顶后座位应在两轮 `tick()` 内跟着变。
- 「最近对话展示时间」在 5.1.8 之后**不再是两层范围**：设置页数字框给 **1–120** 分钟（`RECENT_WINDOW_UI`，`client.js:302`），与存储层上界一致（`RECENT_WINDOW_MINUTES`，`client.js:297`，`0`–`120`，默认 **17**；`0` = 不显示 idle）。仍要两只手都验：页面拖到 `1` 和 `120` 都要能落盘；走 API `window.__HOTLIST_SETTINGS__.set({ collect: { recentWindowMinutes: 0 } })` 也合法（只有页面不提供 0），重载后仍是 0。
- 浮层：真的会在「别的会话进入 error/pending/completed」时弹出来、位置在正确一侧（auto 时看左侧会话栏宽度）、点到图上会切到那个会话、超时自己收回且收回后 DOM 里没有残留节点。
- 浮层的观感：clip 揭示的入场、breath/float 的待机、drop/particles 的退场，以及 `reduceMotion` 时是否只剩 120ms 淡入——单测只能证明属性写对了。
- 离线/缺素材时的回落：删掉某个 `assets/<cat>-<tier>.webp` 后应回落到同名 `.svg`，再删 `.svg` 应回落 emoji，console 里有 `[hotlist] popout` 的 fallback 日志。

## 3. 改动前最小回归清单

按顺序，全部过了再提"改完了"：

1. `node --check client.js index.js test/classify.test.mjs`。
2. `node cangku/tmp/261111_gate_pre_restart.mjs` → `STATIC VERDICT: clean`（查未声明常量、已删字段、新字段与模块形状；`node --check` 抓不到「引用一个没人声明的常量」这类崩溃）。
3. `node test/classify.test.mjs` → `PASS — 109 groups`。
4. 如果碰了排序：断言「同一批会话只变 `updatedAt` → registry 变更数不增加」（组 `adapter plan`），否则 tab 会每 30s 抖一次。
5. 如果碰了注册/注销：断言座位 id 仍带 `hotlist-seat-` 前缀、`stop()` 后无残留节点/属性/样式（组 `adapter sidebar markers`、`surface gating`）。
6. 如果碰了 CSS：断言所有样式文本不含 `[[`，且 takeover 规则只出现在 `data-hotlist-style="takeover"` 的 `<style>` 里（组 `takeover gate`、`styles stay valid`）。
7. 如果碰了设置模型：`README.md` 的可配置项表要同步（与 `defaultSettings()` 一一对应），并跑 `settings sanitizing` + `migrate v3 to v4` + `recent window migration and clamping` + `recent window UI bounds match the API`（页面 1–120、存储 0–120，默认 17 —— 5.1.8 之前页面只到 36、默认 5）；`SETTINGS_VERSION` 变了就补一条迁移与一条「旧版本安全归一化」用例；另外三条是「不破坏用户设置」的守门组，改默认值或顺序时必跑：`defaults never overwrite stored values` / `user settings are never overwritten` / `legacy default order is adopted, real choices are kept` / `factory presets are replaced, user choices are kept`（专治「改了出厂默认但老用户没动」：临时去掉 `LEGACY_VALUES` 的闸门，它必须变红）与 `user picks survive the preset rule`（专治「闸门把用户选的值也改了」：把 `isChoice` 短路成 `() => false`，它必须变红）。
8. 如果碰了动效：跑 `sidebar motion bursts`（每类每 tick 一次随机、频率 0 不掷、并发上限、reduce 全停）与 `preview loop lifecycle`（0/0.5/1 三档的 `animation` 字符串）。
9. 如果碰了持久化：跑 `completedAt persistence`（一次 sync 只写一次、成为主视图立刻删、重启剪枝；列表 `phase` 非 `ready` 时不得丢弃读回的条目）。
10. `VERSION` 升了：`cangku/tmp/` 的验收脚本里的版本断言要同步，否则真机验收会 FAIL。
11. 如果碰了浮层：跑 `popout side resolution` / `popout priority arbitration` / `popout seq guard` / `popout reduce merge` / `popout cooldown` / `popout first entry only`；确认 `makeResolveAsset` 三条分支都不抛、`onDone` 之后节点被移除。
12. 如果碰了热键：跑 `shortcut cycle and guards`；确认没有自己挂 `document.addEventListener('keydown')`，且 `S` 只在 `shortcuts.overlayEnabled` 打开时消费事件。
13. 如果碰了设置页排版：跑 `settings page` / `settings page densified rows` / `settings page writes land immediately`（控件改动必须同步写进 `readSettings()`，座位类两轮 `tick()` 内生效）。
14. 最后才做真机项（§2.3）。
