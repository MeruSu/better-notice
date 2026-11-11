#!/usr/bin/env python3
"""meru-tts —— 把一句话念成音频文件的小工具（拿来生成插件提示音）。

三个 provider（用 --provider 或环境变量 TTS_PROVIDER 选）：
  mimo    小米 MiMo TTS：POST /v1/chat/completions，文本放在 role=assistant，返回 base64 音频
  openai  任何 OpenAI 兼容的 POST /v1/audio/speech（OpenAI 官方，或兼容网关）
  edge    微软 Edge 在线音色，走 edge-tts 包（不需要 key）

配置全部来自环境变量（脚本不读仓库里的任何配置文件，也不写配置）：
  MIMO_API_KEY / MIMO_BASE_URL / MIMO_MODEL / MIMO_VOICE
  OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_VOICE
  TTS_PROVIDER（默认 provider）/ TTS_STYLE（默认语气描述）/ TTS_OUT_DIR（默认输出目录）
  PLAY_BLOCK_PREFIXES（逗号分隔的设备名前缀；默认输出设备名命中这些前缀时不播放）

例子：
  python meru-tts.py --provider mimo --voice 茉莉 --style "轻快友善" --no-play -f mp3 -o out.mp3 "叮咚 完成啦！"
  python meru-tts.py --list-voices
  python meru-tts.py --dry-play
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_MIMO_BASE = "https://api.xiaomimimo.com/v1"
DEFAULT_MIMO_MODEL = "mimo-v2.5-tts"
MIMO_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]

DEFAULT_OPENAI_BASE = "https://api.openai.com/v1"
DEFAULT_OPENAI_MODEL = "tts-1"

# 这些是常见的「内置扬声器」名字前缀。默认输出设备名以它们开头时不自动播放，
# 免得在会议室/开放工位上突然外放。耳机、外置声卡的名字一般不含这些词。
# 用环境变量 PLAY_BLOCK_PREFIXES 覆盖（逗号分隔）；设成空字符串 = 不拦截任何设备。
DEFAULT_BLOCKED_PREFIXES = ("realtek", "speakers", "扬声器")


class TTSError(RuntimeError):
    """Expected, user-facing failure: printed as `ERR <message>` with exit code 2."""


def _post_json(url: str, payload: dict, headers: dict, timeout: float) -> bytes:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read()[:800].decode("utf-8", "replace")
        raise TTSError(f"HTTP {e.code} from {url}: {detail}") from e
    except urllib.error.URLError as e:
        raise TTSError(f"cannot reach {url}: {e.reason}") from e


def synth_mimo(text: str, voice: str, style: str, fmt: str, timeout: float) -> bytes:
    key = os.environ.get("MIMO_API_KEY", "")
    if not key:
        raise TTSError("MIMO_API_KEY is not set (get a key from the MiMo platform, then set the env var)")
    base = os.environ.get("MIMO_BASE_URL", DEFAULT_MIMO_BASE).rstrip("/")
    model = os.environ.get("MIMO_MODEL", DEFAULT_MIMO_MODEL)
    messages = []
    if style:
        # MiMo 把「语气描述」当 user 消息、要念的文本当 assistant 消息。
        messages.append({"role": "user", "content": style})
    messages.append({"role": "assistant", "content": text})
    payload = {"model": model, "messages": messages, "audio": {"format": fmt, "voice": voice}}
    raw = _post_json(f"{base}/chat/completions", payload, {"api-key": key}, timeout)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise TTSError(f"non-JSON response: {raw[:300]!r}") from e
    audio = (data.get("choices") or [{}])[0].get("message", {}).get("audio")
    if not isinstance(audio, dict) or not audio.get("data"):
        raise TTSError(f"no audio in response: {json.dumps(data, ensure_ascii=False)[:500]}")
    return base64.b64decode(audio["data"])


def synth_openai(text: str, voice: str, fmt: str, timeout: float) -> bytes:
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        raise TTSError("OPENAI_API_KEY is not set (set the env var, or pass --provider edge for a keyless run)")
    base = os.environ.get("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE).rstrip("/")
    model = os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
    payload = {"model": model, "input": text, "voice": voice, "response_format": fmt}
    return _post_json(f"{base}/audio/speech", payload, {"Authorization": f"Bearer {key}"}, timeout)


def synth_edge(text: str, voice: str, timeout: float) -> bytes:
    """edge 不需要 key，只要 `pip install edge-tts`；输出永远是 mp3。"""
    try:
        import asyncio

        import edge_tts  # type: ignore
    except ImportError as e:
        raise TTSError("edge provider needs: pip install edge-tts") from e
    out = bytearray()

    async def run() -> None:
        comm = edge_tts.Communicate(text, voice)
        async for chunk in comm.stream():
            if chunk.get("type") == "audio":
                out.extend(chunk["data"])

    asyncio.run(run())
    return bytes(out)


def pick_provider(cli: str | None) -> str:
    """--provider 优先，其次 TTS_PROVIDER，再按哪个 key 存在推断，最后退回 edge（无需 key）。"""
    if cli:
        return cli
    if os.environ.get("TTS_PROVIDER"):
        return os.environ["TTS_PROVIDER"]
    if os.environ.get("MIMO_API_KEY"):
        return "mimo"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    return "edge"


def default_voice(provider: str) -> str:
    if provider == "mimo":
        return os.environ.get("MIMO_VOICE", "mimo_default")
    if provider == "openai":
        return os.environ.get("OPENAI_VOICE", "alloy")
    return os.environ.get("EDGE_VOICE", "zh-CN-XiaoxiaoNeural")


def blocked_prefixes() -> tuple[str, ...]:
    """播放拦截用的设备名前缀（小写）。PLAY_BLOCK_PREFIXES 为空字符串时返回空元组 = 不拦截。"""
    raw = os.environ.get("PLAY_BLOCK_PREFIXES")
    if raw is None:
        return DEFAULT_BLOCKED_PREFIXES
    return tuple(part.strip().lower() for part in raw.split(",") if part.strip())


def _device_name() -> str:
    """当前默认输出设备的名字，读不到时返回 ''。"""
    # pylibs 与本脚本同级；只在 Windows 上有意义（pycaw 走 COM）。
    here = Path(__file__).resolve().parent
    libs = str(here / "pylibs")
    if libs not in sys.path:
        sys.path.insert(0, libs)
    try:
        from pycaw.utils import AudioUtilities  # type: ignore

        return str(AudioUtilities.GetSpeakers().FriendlyName or "")
    except Exception:
        return ""


def play_guard() -> tuple[bool, str]:
    """(allowed, reason)：默认输出设备是不是内置扬声器，能不能自动播放。"""
    name = _device_name()
    if not name:
        return False, "device-unknown (needs Windows + pycaw to read the default output device)"
    lowered = name.strip().lower()
    for prefix in blocked_prefixes():
        if lowered.startswith(prefix):
            return False, f"blocked: default output is '{name}'"
    return True, f"allowed: default output is '{name}'"


def play(path: Path) -> str:
    """异步播放 wav；只支持 Windows（winsound）。"""
    if path.suffix.lower() != ".wav":
        return f"skip: need a wav file to play, this one is {path.suffix}"
    try:
        import winsound  # type: ignore
    except ImportError:
        return "skip: playback is Windows-only (winsound)"
    winsound.PlaySound(str(path), winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
    return "playing async"


def default_out(provider: str, fmt: str) -> Path:
    out_dir = Path(os.environ.get("TTS_OUT_DIR") or Path.cwd() / "tts_out")
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{provider}-{time.strftime('%Y%m%d-%H%M%S')}.{fmt}"


def _utf8_stdio() -> None:
    """帮助文案是中文的；固定成 UTF-8，免得在非中文代码页的 Windows 上打印时炸掉。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:
            pass


EPILOG = """\
三个 provider 与各自需要的环境变量:
  mimo    需要 MIMO_API_KEY（小米 MiMo 开放平台，注册后可申请）
  openai  需要 OPENAI_API_KEY（OpenAI 或兼容网关；用 OPENAI_BASE_URL 指到网关）
  edge    不需要 key，但要先 pip install edge-tts（输出固定 mp3）

用法示例:
  mimo:
    python meru-tts.py --provider mimo --voice 茉莉 --style "轻快友善" --no-play -f mp3 -o out.mp3 "叮咚 完成啦！"
  openai:
    python meru-tts.py --provider openai --voice alloy --no-play -f mp3 -o out.mp3 "Task finished"
  edge:
    python meru-tts.py --provider edge --voice zh-CN-XiaoxiaoNeural --no-play -f mp3 -o out.mp3 "任务完成"

其它环境变量:
  MIMO_BASE_URL / MIMO_MODEL / MIMO_VOICE
  OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_VOICE
  EDGE_VOICE, TTS_PROVIDER, TTS_STYLE, TTS_OUT_DIR
  PLAY_BLOCK_PREFIXES  逗号分隔的设备名前缀，默认 "realtek,speakers,扬声器"；
                       默认输出设备名以其中之一开头就不自动播放；设成空字符串则不拦截任何设备

关于播放:
  --no-play   生成文件后不往扬声器播（脚本/自动化里请加这个）
  --dry-play  不生成音频，只打印本机默认输出设备的判断结果：PLAY allowed: ... / SILENT blocked: ...
"""


def main(argv: list[str] | None = None) -> int:
    _utf8_stdio()
    ap = argparse.ArgumentParser(
        prog="meru-tts.py",
        description="把一句话念成音频文件：mimo / openai 兼容接口 / edge-tts。",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("text", nargs="*", help="要念的文本；省略则从 stdin 读")
    ap.add_argument("-o", "--out", help="输出文件路径（默认 ./tts_out/<provider>-<时间>.<格式>）")
    ap.add_argument("-p", "--provider", choices=["mimo", "openai", "edge"], help="选 provider；不填则按环境变量推断")
    ap.add_argument("-v", "--voice", help="音色 id（各 provider 不同）；--list-voices 看已知列表")
    ap.add_argument("-s", "--style", help="语气描述，自由文本（mimo 用得到，openai/edge 忽略）")
    ap.add_argument("-f", "--format", choices=["mp3", "wav"], help="音频格式，默认 mp3（edge 固定 mp3）")
    ap.add_argument("-t", "--tags", help="风格标签，会包成（标签）加在文本前面")
    ap.add_argument("--timeout", type=float, default=120.0, help="请求超时秒数，默认 120")
    ap.add_argument("--play", dest="play", action="store_true", default=True,
                    help="生成后播放（默认）；仅当默认输出设备不是内置扬声器时才真的播")
    ap.add_argument("--no-play", dest="play", action="store_false", help="只写文件，不往扬声器播")
    ap.add_argument("--dry-play", action="store_true", help="只打印播放判断（PLAY/SILENT）并退出，不生成音频")
    ap.add_argument("--list-voices", action="store_true", help="列出已知音色并退出")
    args = ap.parse_args(argv)

    if args.dry_play:
        allowed, reason = play_guard()
        print(f"{'PLAY' if allowed else 'SILENT'} {reason}")
        return 0

    if args.list_voices:
        print("mimo:", ", ".join(MIMO_VOICES))
        print("openai: alloy, echo, fable, onyx, nova, shimmer")
        print("edge: run `edge-tts --list-voices`")
        return 0

    text = " ".join(args.text) if args.text else sys.stdin.read()
    text = text.strip()
    if not text:
        ap.error("no text given (positional args or stdin)")

    if args.tags:
        tags = args.tags.strip().strip("()（）[]")
        text = f"（{tags}）{text}"

    provider = pick_provider(args.provider)
    voice = args.voice or default_voice(provider)
    style = args.style if args.style is not None else os.environ.get("TTS_STYLE", "")
    fmt = args.format or "mp3"

    if provider == "mimo":
        audio, ext = synth_mimo(text, voice, style, fmt, args.timeout), fmt
    elif provider == "openai":
        audio, ext = synth_openai(text, voice, fmt, args.timeout), fmt
    elif provider == "edge":
        audio, ext = synth_edge(text, voice, args.timeout), "mp3"
    else:  # pragma: no cover
        raise TTSError(f"unknown provider {provider}")

    out = Path(args.out) if args.out else default_out(provider, ext)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(audio)
    print(f"OK {provider} voice={voice} bytes={len(audio)} file={out}")
    if args.play:
        allowed, reason = play_guard()
        if not allowed:
            print(f"SKIP play: {reason}")
        elif ext != "wav":
            print(f"SKIP play: {reason}; format is {ext}, pass -f wav to enable playback")
        else:
            result = play(out)
            if result.startswith("skip:"):
                print(f"SKIP play: {result[5:].strip()} ({reason})")
            else:
                print(f"PLAY {result} ({reason})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except TTSError as e:
        print(f"ERR {e}", file=sys.stderr)
        sys.exit(2)
