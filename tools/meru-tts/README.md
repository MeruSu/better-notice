# meru-tts

把一句话念成音频文件的小工具，用来给 [Better Notice](../../README.md)（`@merusu/dsh-better-notice`）生成提示音。

它**不参与插件运行**——只是一台「台词 → wav/mp3」的离线小机器。插件装好不装它也能响：自带 `attention.wav`（待处理 / 报错）与 `complete.wav`（完成）两个音效。只有当你想换台词、加新音效时才需要它。

> **先说清楚一件事**：`dsh plugin add` 一键安装**拿不到这个工具**。npm 包的 `files` 只含 `index.js`、`client.js`、`cordis.patch.yml`、`assets`，`tools/` 不在包里。要用它，只能去 GitHub **clone 仓库**。

## 依赖

- **Python 3.10+**（只用到标准库 + 下面这些自带包）。
- 播放守卫要用的三个包（`comtypes` / `psutil` / `pycaw`）已经裁剪好放在本目录的 `pylibs/` 里，脚本启动时自己会加进 `sys.path`——**不需要 `pip install` 任何东西**。
- 只有 edge provider 例外：它要额外的 `edge-tts` 包（`pip install edge-tts`），因为那个包会经常更新。

整个目录可以拷到任何地方自包含运行，不会污染系统 Python。

## 三个 provider

| provider | 需要什么 | 输出 |
|---|---|---|
| `mimo` | 环境变量 `MIMO_API_KEY`（小米 MiMo 开放平台） | mp3 / wav |
| `openai` | 环境变量 `OPENAI_API_KEY`（OpenAI 官方，或任何兼容网关，用 `OPENAI_BASE_URL` 指过去） | mp3 / wav |
| `edge` | 无需 key，但要先 `pip install edge-tts` | 固定 mp3 |

不指定 provider 时的推断顺序：`--provider` → `TTS_PROVIDER` → 有 `MIMO_API_KEY` 就 mimo → 有 `OPENAI_API_KEY` 就 openai → 否则 edge。

## 最小用法

**mimo**（推荐，中文音色自然）：

```powershell
$env:MIMO_API_KEY="你的 key"
python meru-tts.py --provider mimo --voice 茉莉 --style "轻快友善" --no-play -f mp3 -o out.mp3 "叮咚 完成啦！"
```

**openai**：

```powershell
$env:OPENAI_API_KEY="你的 key"
python meru-tts.py --provider openai --voice alloy --no-play -f mp3 -o out.mp3 "Task finished"
# 走兼容网关：$env:OPENAI_BASE_URL="https://your-gateway/v1"
```

**edge**（不要 key，适合先试试水）：

```powershell
pip install edge-tts
python meru-tts.py --provider edge --voice zh-CN-XiaoxiaoNeural --no-play -f mp3 -o out.mp3 "任务完成"
```

不写 `-o` 时文件落在 `./tts_out/<provider>-<时间>.<格式>`（可用 `TTS_OUT_DIR` 改目录）。

音色别靠记忆猜，用 `--list-voices` 看当前写死的列表；edge 的音色用 `edge-tts --list-voices` 查。

## 怎么免费拿到 MiMo 的 API key

1. 去**小米 MiMo 开放平台**注册账号，申请 TTS 的 API key（要手机号/实名，这一步只能你自己做）。
2. 平台对新用户有**免费额度**，个人做几个提示音完全够用——不用先充值。
3. 把 key 放进环境变量（PowerShell，只对当前窗口有效）：

```powershell
$env:MIMO_API_KEY="sk-..."
```

要长期保留就写进用户环境变量：`setx MIMO_API_KEY "sk-..."`（新开窗口才生效）。

## 生成的音频怎么装进插件

**路线一：丢进 `assets/sounds/`（装机自带，跟着插件一起发布）**

把文件放进仓库的 `assets/sounds/`，文件名用 `attention.wav` / `complete.wav` 就直接生效（名字不变不用改代码；映射写在 `client.js` 的 `BUILTIN_SOUND`）。要加**新**文件则同时改 `BUILTIN_SOUND` 和 `assets/sounds/manifest.json`。

**路线二：用户自己上传（不动仓库，只改本机设置）**

- 界面：热表设置页 → 对应类别卡 → 音效组 → 上传。
- 代码：`window.__HOTLIST__.assets.add(category, 'sound', { name: 'out.mp3', dataUrl: 'data:audio/mpeg;base64,...' })`，`category` 取 `pending` / `error` / `completed`。返回 `{ ok: true, bytes }`，失败时 `reason` 是 `full` / `budget` / `refused` / `invalid`。

**装之前先看体积**（硬限制，超了直接拒收）：

- 单份音效 **≤128 KB**
- 每个类别最多 **6 份**
- 所有上传素材合计 **≤2 MB**

自带的两个音效各 53804 B（PCM mono 24 kHz 16-bit，1.12 s），离上限还远；换成 mp3 通常只有几 KB。

## 播放守卫：为什么默认不往扬声器播

脚本默认带播放（`--play`），但**只在默认输出设备不是内置扬声器时才真的播**，免得在会议室或开放工位上突然外放。

判断方式是读当前默认输出设备的名字，看是否以这些前缀开头（不区分大小写）：

```
DEFAULT_BLOCKED_PREFIXES = ("realtek", "speakers", "扬声器")
```

名字命中就判定为「内置扬声器」→ 不播；耳机、外置声卡一般不含这些词 → 播。这份列表可以用环境变量覆盖：

```powershell
$env:PLAY_BLOCK_PREFIXES="realtek,speakers,扬声器"   # 自定义
$env:PLAY_BLOCK_PREFIXES=""                          # 空字符串 = 不拦截任何设备，总是播
```

想先看它怎么判的，用 `--dry-play`——**不生成音频**，只打印一行结论并退出：

```powershell
python meru-tts.py --dry-play
# PLAY allowed: default output is '耳机 (USB Audio)'
# SILENT blocked: default output is 'Speakers (Realtek High Definition Audio)'
```

自动化里请一律加 `--no-play`，别指望守卫——它只是「防意外」，不是「保证静音」。

另外 Windows 的 `winsound` 只能播 wav，所以 `-f mp3` 加播放的组合在 Windows 上不成立（脚本会打一行 `SKIP play` 说明）。

## 其它

- 脚本**不写任何配置**，key 只从环境变量读。
- 环境变量全表：`MIMO_API_KEY` / `MIMO_BASE_URL` / `MIMO_MODEL` / `MIMO_VOICE`、`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` / `OPENAI_VOICE`、`EDGE_VOICE`、`TTS_PROVIDER`、`TTS_STYLE`、`TTS_OUT_DIR`、`PLAY_BLOCK_PREFIXES`。
- 完整参数：`python meru-tts.py --help`。
- 出错时统一是 `ERR <原因>` + 退出码 2（例如没设 key），不会甩一坨栈。
