"""Neural speech synthesis for @local/voice-tts.

Renders one phrase to an MP3 file with edge-tts (Microsoft's online neural
voices, the same ones Edge uses for Read Aloud). The host plugin spawns this
script per request; text arrives through a file so quoting never matters.

Usage:
    python tts_edge.py --text-file TEXT --out OUT --voice VOICE
                       [--rate +0%] [--volume +0%] [--pitch +0Hz]
"""

import argparse
import asyncio
import sys

import edge_tts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render text to MP3 with edge-tts")
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--voice", default="ru-RU-SvetlanaNeural")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--volume", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    return parser.parse_args()


async def render(args: argparse.Namespace) -> None:
    with open(args.text_file, encoding="utf-8") as handle:
        text = handle.read().strip()
    if not text:
        raise SystemExit("empty text")

    communicate = edge_tts.Communicate(
        text,
        args.voice,
        rate=args.rate,
        volume=args.volume,
        pitch=args.pitch,
    )
    await communicate.save(args.out)


def main() -> int:
    args = parse_args()
    try:
        asyncio.run(render(args))
    except Exception as error:  # noqa: BLE001 - the host reports this text.
        print(f"edge-tts failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
