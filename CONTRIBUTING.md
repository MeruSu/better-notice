# 参与改进 · Contributing

感谢你愿意动手。这个仓库的改动都会直接进用户的 Web UI，所以下面几条不是形式：**先在本地 profile 里跑通，再提 PR**。

## 环境

需要 Node.js（`node --check` / `node test/...` 只用到标准库，没有 npm 依赖，不需要 `npm install`）和一份 DSH Web profile。

```powershell
git clone https://github.com/MeruSu/better-notice.git C:\src\better-notice
dsh plugin --profile <profile> add C:/src/better-notice
```

- 用 **绝对路径、正斜杠**（`add <目录>` 装的就是 `link:`）。`dsh plugin` 是把参数在 profile 目录里转交给 pnpm 的，相对路径会落到 profile 里去。
- 装完**重启该 profile 的 GUI**。之后只改 `client.js` 就不用再重启了——刷新页面即加载新代码。
- **别拿正在用的 profile 做试验**。另建一个（比如 `test`）装，改坏了不影响你日常那个。

## 两边各改什么

| 文件 | 跑在哪 | 改完怎么生效 |
|---|---|---|
| `client.js` | 浏览器（单文件，包在 DSH 的模块加载器里） | 刷新页面 |
| `index.js` | 宿主进程（只注册 `/hotlist-sound/` 音频路由） | **重启 GUI** |
| `cordis.patch.yml` | bundle patch | **重启 GUI** |
| `package.json` | 包描述（`dsh.client` / `dsh.bundle` 决定怎么加载） | **重启 GUI** |
| `assets/`、`assets/sounds/` | 静态素材 | 刷新页面 |
| `test/classify.test.mjs` | Node | 无 |

`client.js` 没有构建步骤，也没有 import：所有代码在一个工厂函数里，靠 `window.__ModuleLoader__` 收进去。别加打包工具、别拆文件——宿主按这个形状加载。

## 验证

改完按顺序走一遍，**每一步都要看到预期输出**：

```powershell
cd C:\src\better-notice

node --check client.js          # 语法闸门。client.js 的语法错只在真机 boot 时炸，没有别的地方会替你发现
node --check index.js
node test/classify.test.mjs     # 期望最后一行：PASS — 58 groups
```

然后进真机：

1. **强刷页面**（`Ctrl+F5`），控制台敲 `window.__HOTLIST_VERSION__`，必须是 `'4.5.0'`（或你改后的版本号）。不是旧值说明加载的还是缓存。
2. 打开 设置 → 热表，确认设置页能渲染、7 张卡都在。
3. 按你改的那块功能实际走一遍：座位数量、侧栏图标、弹出图、音效。**能在界面上看见的才算改完**，单测绿了不代表平时能看。
4. 改了 `index.js` / `cordis.patch.yml` / `package.json` 的，**重启 GUI 再看**，光刷新不算。

新增或改动单测组时，同步更新 [docs/TESTING.md](docs/TESTING.md) §1.2 的表格（一行一组，`test:<行号>`）和组数（现在是 58）。

## 一条必须记住的教训：宿主会调用的回调，传函数，不要传值

**4.3.0 把三组快捷键的 `label` 传成了已经算好的字符串，整个 Web UI 起不来。**

宿主（`dsh-client-shortcuts`）不是把你的 `label` 当字符串用，它会在建目录时调用 `command.label()`（`dsh-client-shortcuts/lib/client.js:1190`、`:1249`）。传字符串的结果是 `TypeError: command.label is not a function`——而且这个错发生在 boot 阶段，**挂掉的是整个 Web UI，不是热表这一个功能**，用户看到的是白屏。

正确写法（`client.js:4407-4413` 的注释就写着这条）：

```js
// label 是 thunk：宿主稍后自己调 command.label() 取当前文案。
register('hotlist.cycle.prev', 'BracketLeft', () => t('shortcuts.cyclePrev'));
```

通则：**凡是宿主（或别的插件）加了以后由它调用的字段——`label`、`describe`、`getX`、`render`——一律传函数。** 传值的后果是延迟到对方的调用时刻才炸，测试和 `node --check` 都拦不住你，因为你写的是合法 JS。

单测组 `shortcut labels are thunks`就是守这条的。它只抓「已经知道的字段」，新接一个宿主 API 时要自己想一遍：这个字段是我调用，还是它调用？

更一般的规矩：**宿主 API 的字段语义，读宿主源码确认，别按名字猜。** 拿不准就在 PR 里写「未确认」。

## 什么改动必须配迁移

设置存在用户的浏览器里，会跨版本存活很久。

- **只新增字段 / 只新增一个类别子项**：不用升版本、不用写迁移。读取时每个字段各自回落默认（`sanitizeSettings`，`client.js:772`），老记录缺这个键就是默认值。v4.1 加 `glyph.source` 就是这么做的。
- **改字段含义、改结构、删字段、改默认语义**：**必须**在 `migrateSettings` / `upgradePatch`（`client.js:900`、`:1104`）里写迁移，并把 `SETTINGS_VERSION`（`client.js:107`，当前 `4`）加一。不写迁移 = 老用户的设置读出来是错的，而且不报错。
- **动到座位 id 前缀或旧 view id**（`hotlist-seat-`、`session-switcher`）：先看 `docs/ARCHITECTURE.md` §3——`healViewPreferences` / `repairSourcePreference` 那套修补是有原因的，删掉会让老用户的 tab 顺序错乱，严重时把宿主拖进 React #185 死循环。
- **动设置键名**：`SETTINGS_KEY` 变了等于所有用户设置清零，必须配迁移读旧键。

迁移写完至少加一组单测：给一份 v3（或上一个 v4）的原始设置，断言迁移后的形状。

## 提交

- 提交信息**中文**，写清**是什么 + 为什么**，别只写「fix」「update」。
  - 好：`热表 v4.3.1：修 v4.3.0 的快捷键 label 回归（改回 thunk）`
  - 差：`fix bug`
- 一个提交只做一件事。格式化、重命名混在功能改动里，复核时看不出哪行是真正的改动。
- 改了用户能看见的行为，同步更新 [CHANGELOG.md](CHANGELOG.md)（一条一段：改了什么、为什么、影响谁）。
- 版本号在两处，必须一致：`client.js` 的 `VERSION`（`client.js:82`）与 `package.json` 的 `version`。发布版两者同步（当前都是 `4.5.0`）；`package.json` 的 `version` 同时是 npm 分发版本号。

## 几件不要做的事

- **不要加全局 `window.onerror` / `unhandledrejection` 吞错**。宿主有个已知的 `uiConversation.binding: unknown session` 会抛一次（见 README「已知限制」2），它不在本插件调用栈里；加全局兜底会把以后真出的错一起盖住。要处理就处理自己栈里的。
- **不要调宿主的下一个 tick 去「绕开时序」**。座位挂载/注销是按帧和 debounce（`RESIZE_DEBOUNCE_MS`、`SHRINK_CONFIRM_MS`）设计的，套一层 `setTimeout(0)` 会把竞态从「能复现」变成「偶发」。
- **不要为了通过单测去改单测的意图**。这套测试故意不 mock 内部实现、直接跑真源码；把断言改松等于把这道闸门拆了。
- **素材上限常量**（`ASSET_POOL_MAX`、`GLYPH_MAX_BYTES`、`POPOUT_MAX_BYTES`、`SOUND_MAX_BYTES`、`ASSET_TOTAL_MAX_BYTES`、`GLYPH_SOURCE_MAX_BYTES`）同时被设置页文案、上传校验和 `docs/EXTENDING.md` 引用，改一个要改三处。

## PR 前自查

- [ ] `node --check client.js` 和 `node --check index.js` 都过
- [ ] `node test/classify.test.mjs` 末行是 `PASS — 58 groups`（或你更新后的组数）
- [ ] 强刷后 `window.__HOTLIST_VERSION__` 是新版本号
- [ ] 在真机界面上实际看过改动（不是只看测试输出）
- [ ] 改了设置形状的，迁移和迁移单测都在
- [ ] 改了用户可见行为的，CHANGELOG 有一条
- [ ] 改动只碰了该碰的文件，没夹带格式化的无关 diff