# 扩展热表（Hot List）

这份文档写给三种人：想改热表行为的另一个 AI、想批量灌素材的脚本作者、以及三个月后回来维护它的我。
目标只有一个：**读完这一页就能把活儿干完，不必读 `client.js`（4000 行）**。

热表是纯前端插件（`@merusu/dsh-better-notice`），三个渲染面共用一层判定：

| 面 | 宿主槽位 | 出现什么 |
| --- | --- | --- |
| 对话区 tab 行 | `conversation.view`（每会话一个座位） | 热会话的 tab，图标 + 标题 |
| 侧栏会话行 | 宿主 DOM（`[role="treeitem"][data-row-key^="…"]`） | 行内标题前的状态图标 |
| 设置页 | `settings.section`（id `hotlist`） | 6 张类别卡 + 全局区 |

判定链是纯函数：`classify()` → `sortSeats()` → `buildSeatPlan()`。tab 与侧栏因此永远不会对同一会话给出两种状态。

---

## 1. 两个入口

### 1.1 `window.__HOTLIST_SETTINGS__`（v4.1.0 起可用，v4.2.0 与 `window.__HOTLIST__` 并存，v4.3.1 起快捷键生效，v4.4.0 起设置页精简为维护批形态，v4.5.0 删掉弹出图尺寸行并改成双 wav 音效）

```js
const api = window.__HOTLIST_SETTINGS__;
api.version            // 4 —— 设置 schema 版本，不是插件版本
api.get()              // 返回完整设置对象（深拷贝）
api.set(patch)         // 合并写入并立刻生效（部分对象即可）
api.reset()            // 全部恢复默认
api.subscribe(fn)      // 订阅变更，返回取消订阅函数
api.override(patch)    // 临时覆盖，不落盘
api.defaults()         // 默认设置（深拷贝）
api.glyphOf(token)     // 状态 token → 当前图标（字符串）
api.emojiOf(token)
api.lastError()        // 最近一次写盘错误（字符串或 null）
```

同一对象也挂在旧名 `window.__SESSION_SWITCHER_SETTINGS__`（v2.x 兼容，别在新代码里用）。
插件版本号在 `window.__HOTLIST_VERSION__`（当前 `'4.5.0'`）。

写设置后不需要刷新页面：tab、侧栏、设置页都在同一个 store 上重算。

### 1.2 `window.__HOTLIST__`（v4.2 对外 API）

```js
window.__HOTLIST__ = {
  version,                                                    // 插件版本字符串
  settings: {
    get,                                                      // 取当前设置（快照，改它无效）
    set(patch),                                               // 两级浅合并写入
    reset(),                                                  // 回到默认值
    subscribe(fn),                                            // 订阅变更，返回退订函数
    backups(),                                                // 历史落盘副本 [{at, version}]，最新在前
    restore(index),                                           // 把某份副本写回去，返回 {ok, at?}
  },
  assets: {
    add(category, kind, item),   // 追加一份素材，item = { name, dataUrl } → { ok, bytes?, reason? }
    list(category, kind),        // 当前池的摘要，元素 { name, bytes }（不含 dataUrl）
    clear(category, kind),       // 清空该池，返回 boolean
    preview(category),           // 立刻播一条该类别池里的音效（试听），返回是否播放
  },
};
```

`settings` 上**没有** `defaults`（别照旧文档写：取默认值用 `sanitizeSettings({})` 或者 `get()` 之后看字段）。

`kind` 取值：`'glyph'`（图标图）、`'popout'`（弹出图）、`'sound'`（音效）。
`category` 取值：`'pinned' | 'error' | 'pending' | 'completed' | 'running' | 'idle'`（v4.6.1 起 6 类）。

`assets.add` 返回 `{ ok: true, bytes }` 或 `{ ok: false, reason }`，`reason` ∈ `'invalid'`（参数不对）/ `'full'`（该池已满）/ `'refused'`（素材不合格，见 §4.2）/ `'budget'`（总量超了，写入时被裁回来）。

---

## 2. 设置形状

存储键 `dsh.hotlist.settings.v1`（v2.x 旧键 `dsh.session-switcher.settings` 会自动迁移并删除）。

下面所有字段在 v4.6.1 都已落地：v4.1.0 只有单图/占位音效种类，v4.2.0 把它们换成了素材池，v4.4.0 把动效间隔换成播放频率、把收录窗口搬到全局，v4.5.0 删掉弹出图尺寸的 UI（`overlay.sizeMin/sizeMax` 仍是 API 字段）并把内置音效固定成两个 wav，v4.6.0 置顶改读宿主原生并删掉 `settings.pins`，v4.6.1 删掉第 7 类 `favorite` 并把「最近对话展示时间」的 UI 收窄到 1–36 分钟（读旧记录时缺字段一律回落默认，不会报错）。

```js
{
  version: 4,
  maxSeats: 6,                  // 1–12，或 'auto'
  positions: { tab: true, topbar: false, sidebar: true },   // topbar 尚未实现，恒 false
  takeOverStatusDot: true,      // 隐藏别的插件画在行首的状态点
  hideNativeDot: true,          // 隐藏宿主自带的会话状态点
  display: { reduceMotion: 'auto' },   // 'auto' | 'on' | 'off'（API 可写，设置页没有行）
  shortcuts: { jumpEnabled: true, overlayEnabled: false, overlayKey: 'Alt+Shift+S' }, // overlayEnabled 生效；jumpEnabled 恒灰
  overlay: { side: 'auto', sizeMin: 260, sizeMax: 520, fallbackImage: '' },
  collect: { completedTtlMs: 420000, recentWindowMinutes: 5 },  // 前者「刚完成」保持时长 1–1440 分钟；后者「最近对话展示时间」单位分钟，存储范围 0–120、设置页 UI 只给 1–36
  sound: { volume: 60 },        // 全局音量 0–100
  pins: { '<sessionId>': 1 },   // 【v4.6.0 起废弃】置顶改读宿主原生 pinnedSessionIds，此字段不再参与判定，旧盘上读时丢弃
  pinned: { maxSeats: 3 },      // v4.6.0 新增：置顶最多占几个座位，0–12，0 = 不显示置顶
  categories: { <cat>: { …见下… } },
}
```

每个类别（6 个，一个不少）：

```js
{
  enabled: true,
  order: 0,                     // 决定展示顺序（1–99），不影响判定；pinned 默认 15，也是可编辑的
  sortBy: 'time',               // 'time' | 'manual'（pinned 用 manual，按宿主置顶次序）
  pinLevel: null,               // 只读：宿主 pinnedSessionIds 里的下标 + 1（由宿主置顶次序决定，不可手改）
  surfaces: { tab: true, sidebar: true, topbar: false },
  glyph: {
    source: 'emoji',            // 'emoji' | 'upload' | 'popout'
    value: '📌',                // emoji 文本（source='upload' 时忽略）
    uploads: [],                // [{ name, dataUrl }]，source='upload' 时按会话定种取一张
    motion: 'pulse',            // none | spin | pulse | bounce | blink
    motionTarget: 'glyph',      // 'glyph' | 'row'（row 只对侧栏标题生效）
    frequency: 1,               // 0–1，步进 0.05：每 1s 掷一次骰子，1 = 每个节拍都播，0 = 该类永不动（默认按类，见 README 的字段表）
  },
  glyphSecondary: null,         // 仅 pending 有：❓ 小图标，同样带 motion
  popout: {
    enabled: true,              // 只有 error / pending / completed 默认开
    image: '',                  // 'builtin:<cat>' 或 dataURL；空 = 内置
    builtin: true,              // true = 用内置素材
    images: [],                 // [{ name, dataUrl }]；非空时每次弹出随机取一张
    displayMs: 7000,            // 2000–20000，步进 500
    entrance: 'slide',          // 只读：slide | unfold | overshoot | fade，当前固定 clip 揭示
    ambient: 'breath',          // none | breath | float
    exit: 'drop',               // drop | particles | fade | slide-out
    side: 'auto',               // auto | left | right（auto 按侧栏宽度决定）
  },
  sound: {
    kind: 'chime1',             // v4.1 占位字段：none | chime1 | chime2 | alert | upload
    enabled: false,
    builtin: true,              // true = 用内置两个 wav（pending/error → attention.wav，completed → complete.wav）；false = 只用 uploads
    uploads: [],                // [{ name, dataUrl }]，每次事件随机取一条
  },
}
```

### 迁移口径（v3 / v4.0 → v4.5）

- 旧 `categories.<cat>.sound.kind`（`none|alert|chime1|chime2`）：`!== 'none'` → `sound.enabled = true`，然后丢掉 `kind`。
- 旧 `popout.image`（单个 dataURL 字符串）→ `popout.images = [{ name: 'legacy', dataUrl }]`。
- 旧 `glyph.value` 里的 dataURL（v4.0 单图）→ `glyph.uploads = [{ name: 'legacy', dataUrl }]`，`source = 'upload'`。
- 旧全局 `display.motionIntervalMs` → 分发到每个类别的 `glyph.frequency`，公式 `f = 1 − (ms − 2000) / 58000`（2000 → 1、8000 → 0.9、60000 → 0）；旧值 `0` 表示「从不播」，直接迁成 `frequency = 0`。
- 旧每类 `glyph.motionIntervalMs` → 同上换算成该类的 `glyph.frequency`，之后 `motionIntervalMs` 不再写入。
- 旧 `categories.idle.within` → 全局 `collect.recentWindowMinutes`（显式写了 `recentWindowMinutes` 时以它为准，两者都夹到 0–120）；旧字段读一次即忽略。
- 旧 `categories.favorite`（v4.6.0 及更早的第 7 类，恒不产出）在 **v4.6.1 起丢弃**：类别表只剩 6 个键，盘上多出来的 `favorite` 读时扔掉，写回也不再带。
- 旧 `glyph.size` 读时忽略（v4.4 起没有尺寸控件，图标固定按 CSS 尺寸画）。
- 旧 v3 `overlay.scale`（倍数）在 v4.1 起**丢弃**，尺寸改由 `sizeMin/sizeMax` 决定。
- 旧 `pins`（手工置顶级 map）在 **v4.6.0 起废弃**：置顶改读宿主原生 `pinnedSessionIds`，`pins` 不再参与 `classify` / `sidebarStateOf`，盘上有也读时丢弃。老用户的置顶会话如果还想置顶，用宿主侧栏的自带菜单重新置顶一次。

---

全局区里那个窗口现在是 `collect.recentWindowMinutes`（默认 5）：最后活动在这个时间内的普通会话进 `idle`，也就进 tab 的第三级；0 表示完全不显示第三级。

**单位是分钟。范围有两层，别混**：存储层（`sanitizeSettings` 的夹取）是 `0`–`120`，`0` 合法且表示不显示；**设置页那一行只给 `1`–`36`**（默认 5），超出 36 的值不会被夹掉，只是没有界面能输——用 `window.__HOTLIST_SETTINGS__.set({ collect: { recentWindowMinutes: 90 } })` 写进去照样生效并保留。改代码时别把 UI 的上限当成数据上限。

## 3. 随机规则（为什么图标不会闪）

三类素材都是「数组 + 随机取用」，但随机时机不同：

| 素材 | 什么时候取 | 稳定性 |
| --- | --- | --- |
| 图标（seat / 侧栏） | 会话**处在**某个类别 | 定种哈希：同一 `(sessionId, category)` 永远同一张，换类别才换图；reload 不换 |
| 弹出图 | 每次弹出 | 一次性事件，每次重取 |
| 音效 | 每次播放 | 一次性事件，每次重取 |

定种哈希是 FNV-1a 32 位，种子字符串 `"<sessionId>|<category>"`，取模落到池长度：

```
index = fnv1a(seed) % pool.length
```

**种子不含时间**（v4.3.1 起）：同一会话在同一类别里反复渲染、刷新页面都取同一张；只有 `sessionId` 或类别变了才重掷。别把 `Date.now()` 加进去——那会让图标每次渲染都闪。

---

## 4. 素材来源与上限

### 4.1 内置素材（不要改）

- `assets/<cat>-<tier>.webp`：6 类 × 4 档（64 / 320 / 780 / 1560），弹出图与图标（`source: 'popout'`）共用。
- `assets/<cat>.svg`：同 6 类的矢量兜底（webp 加载失败时用）。
- `assets/sounds/attention.wav` 与 `assets/sounds/complete.wav`：两个内置 wav，一对一映射（`pending` / `error` → `attention.wav`，`completed` → `complete.wav`），没有随机池；`assets/sounds/manifest.json` 记 `count: 2` 与 `mapping`。
- 音效播放地址：`/hotlist-sound/<file>`（host 半边注册的前缀路由，同源、不鉴权、`audio/mpeg`、穿越请求 404）。

以上文件由 host 侧静态路由与 package `assets` 导出提供，外部脚本**不需要**碰它们。

### 4.2 用户上传（`assets.add`）的硬上限

| 项 | 上限 | 常量 |
| --- | --- | --- |
| 每类每池份数 | 6 份（用户上传；内置池另算，不受此限） | `ASSET_POOL_MAX = 6` |
| 单份图标（编码后） | ≤ 16 KB | `GLYPH_MAX_BYTES` |
| 单份弹出图 | ≤ 64 KB | `POPOUT_MAX_BYTES` |
| 单份音效 | ≤ 128 KB | `SOUND_MAX_BYTES` |
| 全部上传合计 | ≤ 2 MB（防撑爆 localStorage） | `ASSET_TOTAL_MAX_BYTES` |
| 设置页选中的源文件 | ≤ 4 MB（超过直接拒，不进编码） | `GLYPH_SOURCE_MAX_BYTES` |

图标与弹出图必须是 `image/png`、`image/jpeg`、`image/webp`、`image/gif`（**拒收 SVG**）；音效必须是 `audio/*`。
v4.1.0 用 `GLYPH_MAX_TOTAL_BYTES = 256 KB` 管图标池；v4.2.0 换成统一的 2 MB 总预算，覆盖图标 / 弹出图 / 音效三类素材。
超限一律拒收最新一份，已存的保持不动，并在设置页给一行可见文案。

---

## 5. 批量导入素材

### 5.1 从本地文件（同一浏览器的 File 对象）

```js
async function toDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);   // data:<mime>;base64,…
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function importSounds(files) {
  const api = window.__HOTLIST__;
  for (const file of files) {
    const dataUrl = await toDataUrl(file);
    const ok = api.assets.add('pending', 'sound', { name: file.name, dataUrl });
    console.log(file.name, ok ? 'accepted' : 'rejected');
  }
  console.log('pool:', api.assets.list('pending', 'sound').map((one) => one.name));
}
```

### 5.2 从 URL 批量灌（需要同源或允许 CORS 的地址）

```js
async function importFromUrls(category, kind, urls) {
  const api = window.__HOTLIST__;
  for (const url of urls) {
    const blob = await (await fetch(url)).blob();
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    try {
      api.assets.add(category, kind, { name: url.split('/').pop(), dataUrl });
    } catch (error) {
      console.debug('[hotlist] import failed', url, error);
    }
  }
}

await importFromUrls('error', 'popout', ['/my-art/error-a.png', '/my-art/error-b.png']);
```

- 想换成内置池就用 `assets.clear(category, 'popout')`，再把 `categories.<cat>.popout.builtin` 设回 `true`（`settings.set`）。
- 图标想用上传池：`settings.set({ categories: { error: { glyph: { source: 'upload' } } } })`。
- 音效想只用上传池：`settings.set({ categories: { pending: { sound: { enabled: true, builtin: false } } } })`。

### 5.3 直接写设置（等价路径）

`assets.add` 只是 `settings.set` 的语法糖——它把 `{ name, dataUrl }` 推进对应数组并校验配额。没有 `window.__HOTLIST__` 时（例如 v4.1.0）可以直接：

```js
const now = window.__HOTLIST_SETTINGS__.get();
now.categories.error.sound.enabled = true;
window.__HOTLIST_SETTINGS__.set({ categories: { error: { sound: now.categories.error.sound } } });
```

---

## 6. 触发一次试听

三种方式，都走同一条「随机取一条 + 全局音量」的路径：

1. **设置页**：展开任意类别卡 → 音效组 → 「试听」。这是用户路径，试听**绕过**冷启动闸门与 1500 ms 节流（明确点击就该响）。
2. **API**：`window.__HOTLIST__.assets.preview('pending')` → `true` 表示已交给 `<audio>` 播放，`false` 表示该池空或浏览器拒绝 autoplay（原因记在 console.debug）。
3. **临时调试**：`new Audio('/hotlist-sound/attention.wav').play()`，直接打内置文件，不经过设置。

正常事件触发的规则（与试听不同）：

- 只在类别**首次进入**时播（上一轮没有、这一轮有）；
- 同一会话在同一类别里连续多轮不重复播，离开再回来可再播；
- 首轮 sync 不播（避免开页面就一串声音）；
- 两次播放间隔 < 1500 ms 时，后来的直接丢弃（不排队）；
- 音量 = `sound.volume / 100`；autoplay 被拒时静默 + 一条 console.debug，不刷屏。

---

## 7. 你大概会遇到的三个坑

1. **写设置没反应**：`set` 只做两级浅合并——根字段逐个合并、`categories.<cat>` 逐个合并，但**再下一层（如 `glyph`、`popout`、`sound`）是整块替换**。所以 `set({ categories: { error: { glyph: { size: 24 } } } })` 会把 `error.glyph` 的其余键退回默认（`value`、`motion` 全丢）。正确做法：先 `get()`，改完整个对象再 `set()`。
2. **localStorage 满了**：`lastError()` 会返回写入错误，设置页底部也会出现一行提示；清掉一个池（`assets.clear`）再试。总预算 2 MB 就是为这个设的。
3. **改了 `client.js` 不生效**：插件的 client 半边在页面加载时注册，改文件后必须重新加载页面（host bundle 每请求读盘，但已注册的模块不会热替换）。

### 7.1 写错了怎么退回去（保留层与备份）

设置落盘时做了两道保险，**所以你写坏一次不至于把用户的配置清空**：

- **未知字段不丢**：`sanitizeSettings` 只认已知路径，但它不会把不认识的字段扔掉——`collectUnknown()` 把它们搬进另一把键（`PRESERVED_KEY`）存着，下次读盘由 `reviveUnknown()` 搬回原位。所以第三方在设置里塞了自己的字段，本插件升级后它还在。
- **超范围的原始值不丢**：盘上是 `maxSeats: 99` 这种，读的时候按 `1`–`12` 夹取使用，但原值记在保留层里；哪天上限放宽了，`reviveOutOfRange()` 会把 `99` 还回去。
- **每次落盘前存一份滚动备份**：最近 5 份（`BACKUP_KEY`，`BACKUP_LIMIT = 5`），只记 `{at, settings}`。查有哪些副本用 `window.__HOTLIST__.settings.backups()`（返回 `[{at, version}]`，最新在前），要退回某一份用 `settings.restore(0)`（0 = 最近一份，`-1` 或不传 = 最旧一份）。
- **唯一例外**是 `RETIRED_PATHS` 里的路径（例如 v4.6.1 退役的 `categories.favorite`）：这些是插件主动删除的字段，读时丢弃、不进保留层，否则它们会永远跟着用户。
- **另一条例外（v4.6.4 起）：出厂预设不是用户选择。** 盘上某个值只等于我们过去某一代发的默认值（`LEGACY_VALUES`：闲置图标 `💤`、动效 `blink` / `none`、`motionTarget: 'glyph'`、频率 `1`、音效关），就跟随当前默认——用户没改过的东西不该把他锁在旧默认上。用户动过的值一律不动——「动过」由 `choices`（`{ "<路径>": true }`，v4.6.5 起）记录，所以 `none` / `blink` / 「仅图标」/ 频率 100% / 关音效这些和旧默认同值的选项也能落地。
- 想确认这套还在生效：单测 `user settings are never overwritten`、`defaults never overwrite stored values`、`legacy default order is adopted, real choices are kept`（这三组保「不覆盖用户」）与 `factory presets are replaced, user choices are kept`（这一组保「旧预设要换掉」）与 `user picks survive the preset rule`（这一组保「用户选过的值不被闸门改」）红了就是破了。

## 8. 想加功能而不是配置

- 纯判定（分类、排序、上限）在 `classify/sortSeats/buildSeatPlan`，改这里要同步跑单测（`node test/classify.test.mjs`）。
- 新渲染面才需要碰宿主槽位；现有三面之外加第四个面，先看 `docs/ARCHITECTURE.md` 的「扩展点」一节。
- 改动后必须跑：`node --check client.js`、`node --check index.js`、`node --check test/classify.test.mjs`、`node test/classify.test.mjs`。四样全绿才算完。

---

## 9. 这一版的类别判定优先级（4.6.1）

**一个会话只属于一个类别。** `classify()` 从上往下走，第一条命中的就定了，后面的条件不再看。

| 序 | 类别 | 判定条件（大意） |
| --- | --- | --- |
| 1 | `error` | agent 级报错（`api-session/error`，或已打开会话的 `promptError` / `lastAgentError`） |
| 2 | `pending` | `pendingInteraction.kind` 有值（`approval` / `question` / `plan-review` 三种并成这一类） |
| 3 | `completed` | 本插件看到它 `running true → 非 running`，且在 `collect.completedTtlMs` 内 |
| 4 | `running` | 正在干活（含「子代理在跑、父会话空闲」） |
| 5 | `pinned` | 在**宿主原生**置顶列表里 |
| 6 | `idle` | 空闲，且最后活动在 `collect.recentWindowMinutes` 内 |

也就是说：**报错 > 待处理 > 已完成 > 进行中 > 置顶 > 闲置**。置顶排在倒数第二——它表达的是「你想先看」，不是「它在动」；一个置顶会话报错了，它进 `error`，不进 `pinned`。

**置顶来自宿主，不是本插件的设置。** 数据源是 `ctx.get('uiWorkspace').workspaces.list.getSnapshot().pinnedSessionIds`（数组，最近置顶的在前），置顶/取消置顶在宿主侧栏行的原生菜单里。插件这边**只读**，只提供全局「置顶最多显示」（`pinned.maxSeats`，`0`–`12`，`0` = 不显示置顶）来控制它占几个座位。`pinLevel` 直接取数组下标 + 1，所以置顶的先后由宿主的置顶次序决定，插件不提供「上移/下移」。

**展示顺序与判定优先级是两件事。** 展示顺序看每类的 `order`，默认 `error 10 / pending 10 / pinned 15 / completed 20 / running 30 / idle 50`。`error` 与 `pending` 默认同分，**同分时按上面的判定优先级兜底**（也就是 `CATEGORY_ORDER` 常量里 `error` 必须排在 `pending` 前），所以最终看到的是 报错 → 待处理 → 置顶 → 已完成 → 进行中 → 闲置。

**6 类，不是 7 类（v4.6.1 起）。** `CATEGORY_IDS = ['pinned', 'error', 'pending', 'completed', 'running', 'idle']`。v4.6.0 及更早还有第 7 个 `favorite`（收藏，`reserved: true`、恒不产出）；它在 v4.6.1 里被整个删掉——类型、常量、设置页那张卡、i18n 键一起没了，旧盘里的 `categories.favorite` 读时丢弃。想加回一个「收藏」类不是改配置，是加类别（见 §8）。

**老安装的旧默认顺序会被自动升级，逐类判断（v4.6.1 起）。** 判据是「这一类的 `order` 值是否等于某个历史默认值」（`LEGACY_DEFAULTS`）——等于就视为「用户没选过」，换成新版默认。历史值 → 新值：`pinned` 的 `0`（含最早那版的 `1`）→ **15**、`pending` 的 `20` → **10**、`completed` 的 `30` → **20**、`running` 的 `40` → **30**；`error` 一直是 `10`、`idle` 一直是 `50`，不受影响。用户改过的值一个都不会动。这条在 `sanitizeSettings` 里跑，不是一次性脚本，所以每次读盘都会按同一规则判。

改优先级 = 改语义，别只改 `order` 就以为改了判定；两处都要动时，`test/classify.test.mjs` 的 `category order` 与 `sidebar priority` 两组是验收线。