# 扩展热表（Hot List）

这份文档写给三种人：想改热表行为的另一个 AI、想批量灌素材的脚本作者、以及三个月后回来维护它的我。
目标只有一个：**读完这一页就能把活儿干完，不必读 `client.js`（4571 行）**。

热表是纯前端插件（`@local/dsh-hotlist`），三个渲染面都从同一批只读会话状态与同一份设置里判定，但判定函数分两个（tab 面 `classify()`、侧栏面 `sidebarStateOf()`，差别见下）：

| 面 | 宿主槽位 | 出现什么 |
| --- | --- | --- |
| 对话区 tab 行 | `conversation.view`（每会话一个座位） | 热会话的 tab，图标 + 标题 |
| 侧栏会话行 | 宿主 DOM（`[role="treeitem"][data-row-key^="…"]`） | 行内标题前的状态图标 |
| 设置页 | `settings.section`（id `hotlist`） | 7 张类别卡 + 全局区 |

判定链是纯函数：`classify()`（`client.js:1271`）→ `sortSeats()` → `buildSeatPlan()`。侧栏那一面另有一个纯函数 `sidebarStateOf()`（`client.js:1624`），读同样的会话状态与设置，但有两处已知差别：侧栏把 `running` 排在 `completed` 之前（tab 面相反），并且侧栏的 `completed` 认宿主的 `completionUnread`，tab 面只认本插件记下的 `completedAt`。所以「刚跑完又立刻重新开始跑」的会话会短暂地 tab 显示 ✅、侧栏显示 ⏳——这不是 bug 修复项，是两面各自的取舍（见 README「已知限制」第 13 条）。`error` 窗口两面都是 10 分钟：错误表在 `readSnapshot()`（`client.js:4151`）里就按 `ERROR_TTL_MS` 删了，`SIDEBAR_ERROR_TTL_MS`（30 分钟）只是侧栏函数里的第二道闸，碰不到更老的条目。另外，侧栏适配器调 `sidebarStateOf()` 时只传了 `session` / `status` / `error` / `completedAt` / `settings` / `now`（`client.js:1884-1891`），`readSession` 里备好的 `pinned` 与 `children`（`client.js:4329-4330`）没有传进去，所以侧栏既不出 📌、也不把「子代理在跑」并入 ⏳（见 README「已知限制」第 14 条）。

---

## 1. 两个入口

### 1.1 `window.__HOTLIST_SETTINGS__`（v4.1.0 起可用，v4.2.0 与 `window.__HOTLIST__` 并存，v4.3.1 起快捷键生效）

```js
const api = window.__HOTLIST_SETTINGS__;
api.version            // 4 —— 设置 schema 版本，不是插件版本
api.get()              // 返回当前设置对象（内部缓存本身，不是拷贝：别就地改它）
api.set(patch)         // 合并写入并立刻生效（部分对象即可）
api.reset()            // 全部恢复默认
api.subscribe(fn)      // 订阅变更，返回取消订阅函数
api.override(patch)    // 临时覆盖，不落盘
api.defaults()         // 默认设置（每次调用新建一份，改它不影响当前设置）
api.glyphOf(settings, token)   // 状态 token → 当前图标（emoji 或 dataURL）
api.emojiOf(settings, token)   // 状态 token → 只能放字符串的表面上的回落 emoji
api.lastError()        // 最近一次写盘错误（字符串或 null）
```

`glyphOf` / `emojiOf` 是内部函数原样挂出去的（`client.js:985`、`:990`），**第一个参数自己传当前设置**，一般是 `api.get()`。`token` 的取值是 `CATEGORY_OF_TOKEN` 的键（`client.js:184-192`）：`pinned` / `approval` / `question` / `error` / `completed` / `running` / `idle`；待处理在这一层分成 `approval`（主图标）与 `question`（❓ 副图标），没有 `pending`、也没有 `favorite`。未知 token 会回落成 `running` 的默认图标。

同一对象也挂在旧名 `window.__SESSION_SWITCHER_SETTINGS__`（v2.x 兼容，别在新代码里用）。
插件版本号在 `window.__HOTLIST_VERSION__`（当前 `'4.3.1'`）。

写设置后不需要刷新页面：tab、侧栏、设置页都在同一个 store 上重算。

### 1.2 `window.__HOTLIST__`（v4.2 对外 API）

```js
window.__HOTLIST__ = {
  version,                                  // 插件版本字符串，如 '4.3.1'
  settings: { get, set, reset, subscribe }, // 与 1.1 同名同义
  assets: {
    add(category, kind, item),   // item = { name, dataUrl }；返回 { ok, reason?, bytes? }
    list(category, kind),        // 返回当前池：[{ name, bytes }]
    clear(category, kind),       // 清空该池，返回 boolean
    preview(category),           // 立刻播一条该类别池里的音效（试听），返回 boolean
  },
};
```

`kind` 取值：`'glyph'`（图标图）、`'popout'`（弹出图）、`'sound'`（音效）。
`category` 取值：`'pinned' | 'error' | 'pending' | 'completed' | 'running' | 'idle' | 'favorite'`。

`assets.add` 成功返回 `{ ok: true, bytes }`（`bytes` 是收下的那一份的体积），失败返回 `{ ok: false, reason }`，`reason` 是 `'invalid'`（参数不是 `{ name, dataUrl }`）、`'full'`（池已满）、`'refused'`（格式或单份体积不合格）、`'budget'`（总预算不够）之一；拒收时另记一条 `console.debug('[hotlist] asset rejected'…)`。上限见 §4.2。

---

## 2. 设置形状

存储键 `dsh.hotlist.settings.v1`（v2.x 旧键 `dsh.session-switcher.settings` 会自动迁移并删除）。

下面所有字段在 v4.3.1 都已落地：v4.1.0 每类只有一张弹出图和固定的音效种类，v4.2.0 把它们换成了素材池（读旧记录时缺字段一律回落默认，不会报错）。

```js
{
  version: 4,
  maxSeats: 6,                  // 1–12，或 'auto'
  positions: { tab: true, topbar: false, sidebar: true },   // topbar 尚未实现，恒 false
  takeOverStatusDot: true,      // 隐藏别的插件画在行首的状态点
  hideNativeDot: true,          // 隐藏宿主自带的会话状态点
  display: { reduceMotion: 'auto' },   // 'auto' | 'on' | 'off'；只有 'on' 会强制停动效，'auto'/'off' 都不置位，系统偏好照旧生效
  shortcuts: { jumpEnabled: true, overlayEnabled: false, overlayKey: 'Alt+Shift+S' }, // overlayEnabled 生效；jumpEnabled 恒灰
  overlay: { side: 'auto', sizeMin: 260, sizeMax: 520, fallbackImage: '' }, // fallbackImage 只存值，没有渲染出口
  collect: { completedTtlMs: 420000 },  // 「刚完成」保持时长，1–1440 分钟（步进 1 分钟）
  sound: { volume: 60 },        // 全局音量 0–100
  pins: { '<sessionId>': 1 },   // 1–99，越小越靠前；仅 pinned 卡
  categories: { <cat>: { …见下… } },
}
```

每个类别（7 个，一个不少）。下面这份以 `error` 卡为例（`enabled` / `popout.enabled` / `motion` 都是按类取自 `defaultCategory()`，不是全局同一个值）：

```js
{
  enabled: true,                // favorite 恒 false（预留）
  reserved: false,              // favorite 恒 true：那一类不判定、不产出，任何改动被忽略
  order: 0,                     // pinned 恒 0；其余 1–99，决定展示顺序（不影响判定）
  sortBy: 'time',               // 'time' | 'manual'（pinned 用 manual）
  pinLevel: null,               // 遗留字段：恒 null，排序读的是顶层 pins[sessionId]（client.js:1288）
  surfaces: { tab: true, sidebar: true, topbar: false },
  glyph: {
    kind: 'emoji',              // 'emoji' | 'img'（上传后由代码切换）
    source: 'emoji',            // 'emoji' | 'upload' | 'popout'
    value: '📌',                // emoji 文本（source='upload' 时忽略）
    uploads: [],                // [{ name, dataUrl }]，source='upload' 时按会话定种取一张
    size: 20,                   // 只能取 16 / 20 / 24 / 32（会吸附到最近一档）
    motion: 'pulse',            // none | spin | pulse | bounce | blink
    motionTarget: 'glyph',      // 'glyph' | 'row'（row 只对侧栏标题生效）
    motionIntervalMs: 8000,     // 0 = 该类不动；否则 2000–60000，步进 1000
  },
  glyphSecondary: null,         // 仅 pending 有：❓ 小图标，同样带 motion
  popout: {
    enabled: true,              // 只有 error / pending / completed 默认开
    builtin: true,              // true = 用内置素材
    images: [],                 // [{ name, dataUrl }]；非空时每次弹出随机取一张
    displayMs: 7000,            // 2000–20000，步进 500
    entrance: 'slide',          // 只读：当前固定为 clip 揭示（探出）
    ambient: 'breath',          // none | breath | float
    exit: 'drop',               // drop | particles | fade | slide-out
    side: 'auto',               // auto | left | right（auto 按侧栏宽度决定）
  },
  sound: {
    enabled: false,
    builtin: true,              // true = 用内置 21 条（只有 pending/error/completed）；false = 只用 uploads
    uploads: [],                // [{ name, dataUrl }]，每次事件随机取一条
  },
  within: 0,                    // 仅 idle 有效：0–120 分钟，5 = 「五分钟内算闲置」
}
```

上面就是 `defaultCategory()`（`client.js:209`）实际返回的形状，多余键（v4.1 的 `sound.kind`、单个 `popout.image`）在读取时会被迁移掉，不存在于新记录里。

### 迁移口径（v3 / v4.0 → v4.2）

- 旧 `categories.<cat>.sound.kind`（`none|alert|chime1|chime2`）：`!== 'none'` → `sound.enabled = true`，然后丢掉 `kind`。
- 旧 `popout.image`（单个 dataURL 字符串）→ `popout.images = [{ name: 'legacy', dataUrl }]`。
- 旧 `glyph.value` 里的 dataURL（v4.0 单图）→ `glyph.uploads = [{ name: 'legacy', dataUrl }]`，`source = 'upload'`。
- 旧全局 `display.motionIntervalMs` → 分发到每个类别的 `glyph.motionIntervalMs`。
- 旧 v3 `overlay.scale`（倍数）→ 折算成 `overlay.sizeMax = max(clamp(round(scale × 260), 120, 900), 260)`，旧键丢弃（`client.js:882-886`）。`scale: 1` = 260px、`2` = 520px、`3` = 780px；`scale` 为 0 或很小也至少 260（`OVERLAY_SIZE.fallbackMin`），超过 900 的一律按 900 收。

---

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

- `assets/<cat>-<tier>.webp`：7 类 × 4 档（64 / 320 / 780 / 1560），弹出图与图标（`source: 'popout'`）共用。
- `assets/<cat>.svg`：同 7 类的矢量兜底（webp 加载失败时用）。
- `assets/sounds/<cat>-1..7.mp3`：21 条茉莉音色，1.01–2.06 s，合计 241 KB；`assets/sounds/manifest.json` 记 text / voice / style / bytes / seconds。
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

图标与弹出图必须是 `data:image/(png|jpeg|webp|gif);base64,…`（**拒收 SVG**，正则 `GLYPH_IMAGE_RE` `client.js:150`）；音效必须是 `data:audio/<any>;base64,…`（正则 `SOUND_AUDIO_RE` `client.js:172`）——API 这一层不限具体音频格式，设置页的上传控件另限 MP3 / M4A / WAV / OGG / AAC / WebM（`SOUND_FILE_TYPES` `client.js:2091`）。
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
    const res = api.assets.add('pending', 'sound', { name: file.name, dataUrl });
    console.log(file.name, res.ok ? 'accepted' : `rejected (${res.reason})`);
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

`assets.add` 只是 `settings.set` 的语法糖——它把 `{ name, dataUrl }` 推进对应数组并校验配额。没有 `window.__HOTLIST__` 时（v4.1.0 及更早）可以直接：

```js
// 注意：set 的第三层是整块替换，所以要把 sound 整块传回去
const current = window.__HOTLIST_SETTINGS__.get();
const sound = { ...current.categories.error.sound, enabled: true };
window.__HOTLIST_SETTINGS__.set({ categories: { error: { sound } } });
```

别就地改 `get()` 返回的对象——那是插件内部缓存本身（`client.js:1078`），改了不会走净化、不会落盘、也不会广播。

---

## 6. 触发一次试听

三种方式，都走同一条「随机取一条 + 全局音量」的路径：

1. **设置页**：展开任意类别卡 → 音效组 → 「试听」。这是用户路径，试听**绕过**冷启动闸门与 1500 ms 节流（明确点击就该响）。
2. **API**：`window.__HOTLIST__.assets.preview('pending')` → `true` 表示已交给 `<audio>` 播放，`false` 表示该池空或浏览器拒绝 autoplay（原因记在 console.debug）。
3. **临时调试**：`new Audio('/hotlist-sound/pending-1.mp3').play()`，直接打内置文件，不经过设置。

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

## 8. 想加功能而不是配置

- 纯判定（分类、排序、上限）在 `classify/sortSeats/buildSeatPlan`，改这里要同步跑单测（`node test/classify.test.mjs`，53 组）。
- 新渲染面才需要碰宿主槽位；现有三个挂载点（`conversation.view`、侧栏 DOM、`settings.section`）之外要加第四个，先看 `docs/ARCHITECTURE.md` 的「扩展点」一节。
- 改动后必须跑：`node --check client.js`、`node --check index.js`、`node test/classify.test.mjs`（`PASS — 53 groups`）。三样齐才算完。单测里带两道静态扫描（`no undefined constants`、`styles stay valid`），`node --check` 抓不到「引用一个没人声明的常量」这类崩溃，这两组补的就是这个口子。