#!/usr/bin/env python3
"""Minimal text-to-speech CLI for AI agents.

Providers (set with --provider or TTS_PROVIDER):
  mimo    Xiaomi MiMo TTS   POST /v1/chat/completions, text in role=assistant, base64 audio back
  openai  OpenAI-compatible POST /v1/audio/speech (OpenAI, ElevenLabs-compatible gateways, ...)
  edge    Microsoft Edge online voices via the `edge-tts` package (no key)

Config comes from the environment (never from a file in the repo):
  MIMO_API_KEY / MIMO_BASE_URL / MIMO_MODEL / MIMO_VOICE
  OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_VOICE
  TTS_PROVIDER, TTS_STYLE (natural-language style hint), TTS_OUT_DIR

Examples:
  python meru-tts.py "测试一句中文" -f wav -o out.wav
  python meru-tts.py --provider mimo --voice 茉莉 --style "温柔一些" "你好"
  python meru-tts.py --list-voices
  python meru-tts.py --dry-play   # headphone gate: PLAY/SILENT + reason
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


class TTSError(RuntimeError):
    pass


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
        raise TTSError("MIMO_API_KEY is not set")
    base = os.environ.get("MIMO_BASE_URL", DEFAULT_MIMO_BASE).rstrip("/")
    model = os.environ.get("MIMO_MODEL", DEFAULT_MIMO_MODEL)
    messages = []
    if style:
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
        raise TTSError("OPENAI_API_KEY is not set")
    base = os.environ.get("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE).rstrip("/")
    model = os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
    payload = {"model": model, "input": text, "voice": voice, "response_format": fmt}
    return _post_json(f"{base}/audio/speech", payload, {"Authorization": f"Bearer {key}"}, timeout)


def synth_edge(text: str, voice: str, timeout: float) -> bytes:
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
        return os.environ.get("MIMO_VOICE", "茉莉")
    if provider == "openai":
        return os.environ.get("OPENAI_VOICE", "alloy")
    return "zh-CN-XiaoxiaoNeural"


BLOCKED_DEFAULT_PREFIX = "re"  # Realtek speakers; play only when the default endpoint is not these


def _device_name() -> str:
    """Friendly name of the current default render device, or '' when unknown."""
    # pylibs ships next to this file; fall back to the source checkout layout.
    here = Path(__file__).resolve().parent
    libs = next(
        (str(p) for p in (here / "pylibs", here.parent / "cangku" / "pylibs") if p.is_dir()),
        str(here / "pylibs"),
    )
    if libs not in sys.path:
        sys.path.insert(0, libs)
    try:
        from pycaw.utils import AudioUtilities  # type: ignore

        return str(AudioUtilities.GetSpeakers().FriendlyName or "")
    except Exception:
        return ""


def play_guard() -> tuple[bool, str]:
    """(allowed, reason). Silent no-op when pycaw is missing or the endpoint is the built-in speaker."""
    name = _device_name()
    if not name:
        return False, "device-unknown (install pycaw to enable the headphone check)"
    if name.strip().lower().startswith(BLOCKED_DEFAULT_PREFIX):
        return False, f"blocked: default output is '{name}'"
    return True, f"allowed: default output is '{name}'"


def play(path: Path) -> str:
    if path.suffix.lower() != ".wav":
        return f"skip: winsound needs wav, file is {path.suffix}"
    import winsound  # windows only

    winsound.PlaySound(str(path), winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
    return "playing async"


def resolve_sound(name: str) -> Path:
    """'complete' / 'attention' -> the wav bundled in sound/ next to this script."""
    here = Path(__file__).resolve().parent / "sound"
    for cand in (here / f"{name}.wav", here / name):
        if cand.is_file():
            return cand
    raise TTSError(f"sound '{name}' not found in {here}")


def default_out(provider: str) -> Path:
    ext = "mp3"
    out_dir = Path(os.environ.get("TTS_OUT_DIR") or Path.cwd() / "tts_out")
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{provider}-{time.strftime('%Y%m%d-%H%M%S')}.{ext}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Small TTS CLI: mimo / openai-compatible / edge")
    ap.add_argument("text", nargs="*", help="text to speak; reads stdin when omitted")
    ap.add_argument("-o", "--out", help="output file path")
    ap.add_argument("-p", "--provider", choices=["mimo", "openai", "edge"], help="override provider")
    ap.add_argument("-v", "--voice", help="voice id for the chosen provider")
    ap.add_argument("-s", "--style", help="natural-language style hint (mimo / openai chat style)")
    ap.add_argument("-f", "--format", choices=["mp3", "wav"], help="audio format (default mp3)")
    ap.add_argument("-t", "--tags", help="audio style tags, wrapped in （） and prefixed to the text")
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--play", dest="play", action="store_true", default=True,
                    help="play after writing, only when the default output is not the built-in speaker")
    ap.add_argument("--no-play", dest="play", action="store_false")
    ap.add_argument("--dry-play", action="store_true", help="print the play decision and exit")
    ap.add_argument("--list-voices", action="store_true", help="print known voices and exit")
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
    voice = os.environ.get("EDGE_VOICE", voice) if provider == "edge" and not args.voice else voice
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

    if args.out and Path(args.out).suffix == "" and not Path(args.out).parent.name:
        out = resolve_sound(Path(args.out).name)
    else:
        out = Path(args.out) if args.out else default_out(provider).with_suffix("." + ext)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(audio)
    print(f"OK {provider} voice={voice} bytes={len(audio)} file={out}")
    if args.play:
        allowed, reason = play_guard()
        if allowed and ext != "wav":
            print(f"SKIP play: {reason}; format is {ext}, pass -f wav to enable playback")
        elif allowed:
            print(f"PLAY {play(out)} ({reason})")
        else:
            print(f"SKIP play: {reason}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except TTSError as e:
        print(f"ERR {e}", file=sys.stderr)
        sys.exit(2)