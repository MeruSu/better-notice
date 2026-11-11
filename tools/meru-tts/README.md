# meru-tts

生成插件内置提示音用的小工具。**不参与插件运行**，只在你想替换 `assets/sounds/` 里那两个 wav 时用得上。

## 它是什么

一个单文件 Python 脚本，把一句话念成音频。支持三个 provider：

| provider | 说明 |
|---|---|
| `mimo` | 小米 MiMo TTS（`mimo-v2.5-tts`）。默认。需要 `MIMO_API_KEY` |
| `openai` | OpenAI `/v1/audio/speech`。需要 `OPENAI_API_KEY` |
| `edge` | edge-tts（需另外 `pip install edge-tts`） |

自带的 `pylibs/` 只有 `mimo` 与播放守卫用得到的三个包（`comtypes` / `psutil` / `pycaw`），已经裁掉 `__pycache__`、`.exe`、测试等，所以目录很小。

## 怎么用

```powershell
python meru-tts.py --provider mimo --voice 茉莉 --style "轻快友善" --no-play -f wav -o attention.wav "叮咚 等你确认"
```

- `--no-play`：只生成文件，不往扬声器播（自动化必加，否则脚本会自己响）。
- `-f wav|mp3`：输出格式。插件内置素材用 `wav`（host 半边的 `/hotlist-sound` 路由两种都发，但 wav 无损、体积可控）。
- `--voice`：`mimo_default` / `冰糖` / `茉莉` / `苏打` / `白桦` / `Mia` / `Chloe` / `Milo` / `Dean`。用 `--list-voices` 查当前 provider 的完整列表，**别按记忆猜**。
- `--style`：自由文本的语气描述（中文也行），会作为 system 提示的一部分影响念法。
- `--dry-play`：不生成音频，只报告「本机默认输出设备是否允许播放」——判断有没有插耳机。

## 内置那两个音效是怎么来的

`assets/sounds/attention.wav` 与 `complete.wav` 就是本目录 `sound/` 里那两个文件的副本（各 53804 B，PCM mono 24 kHz 16-bit 1.12 s），分别用于：

- `attention.wav` → `pending`（等你审批/回答）与 `error`（报错）
- `complete.wav` → `completed`（刚跑完）

映射写在 `client.js` 的 `BUILTIN_SOUND`（`client.js:184`）。换素材时**文件名保持这两个**就不用改代码；要加新文件则同时改 `BUILTIN_SOUND` 与 `assets/sounds/manifest.json`。

## `pylibs/` 是干什么的

`meru-tts.py` 启动时按顺序找 `here/pylibs` 与 `here/cangku/pylibs`，把第一个存在的目录塞进 `sys.path`（`meru-tts.py:137-144`）。所以这个目录可以整个拷走自包含运行，不污染系统 Python。

`play_guard()`（`meru-tts.py` 内）用 `pycaw` 查当前默认输出设备是不是扬声器——是的话才允许自动播放，避免在会议中途突然出声。只影响不带 `--no-play` 的调用。

## 注意

- 需要 Python 3.10+。Windows 上 `winsound` 只能播 wav，所以 `-f mp3` + 播放组合在 Windows 不成立。
- 工具不会写任何配置；API key 只从环境变量读（`MIMO_API_KEY` / `MIMO_BASE_URL` / `MIMO_MODEL` / `OPENAI_API_KEY`）。
- 生成的文件归你自己；本仓库内置的那两个 wav 用 MiMo TTS 的音色「茉莉」生成，体积与文案记在 `assets/sounds/manifest.json`。
