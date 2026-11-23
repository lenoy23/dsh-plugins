# whisper-stt

DSH bundle that adds a local whisper.cpp speech recognition provider to the voice input, including Russian.

- Provider id: `whisper-local`, location `host-local`.
- Defaults: `D:\AI\whisper\bin\Release\whisper-cli.exe`, model `D:\AI\whisper\models\ggml-small.bin`.
- Offline; audio is transcribed from a temporary WAV file that is removed afterwards.
