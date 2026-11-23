# Whisper local speech recognition

Adds an offline speech recognizer to the DSH voice input. The built-in sensevoice engine understands only Chinese, English, Japanese, Korean and Cantonese; this provider uses whisper.cpp and adds Russian.

## What it does

- Registers the speech provider `whisper-local` with the languages `auto`, `ru`, `en`, `uk`, `de`, `fr`, `es`, `it`, `pl`.
- Receives the same WAV recording the voice input already sends, runs `whisper-cli.exe` in a temporary directory, and returns the recognized text.
- Works fully offline. Audio is written to a temporary file only for the duration of one transcription and then deleted.

## Requirements

- `whisper-cli.exe` from a whisper.cpp Windows build on `D:\AI\whisper\bin\Release\`.
- A ggml model on `D:\AI\whisper\models\ggml-small.bin` (multilingual, understands Russian).

Both paths can be changed in the bundle configuration (`binaryPath`, `modelPath`, `threads`).

## Limitations

- CPU inference: a 5–10 second phrase takes a few seconds on a desktop CPU.
- The `small` model makes occasional word-level mistakes, mostly on names and rare words.
- The provider is a plain host plugin over the experimental speech API; a future DSH release may change that API.
