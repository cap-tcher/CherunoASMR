# models

語音引擎的模型放這裡。`startserver.bat` 第一次會自動下載；已經自己下載好的話，照下面放好，startserver 檢查到檔案大小對就不會重下。

## ZONOS3-Mini（`models/zonos/`）
來源：https://huggingface.co/Zyphra/ZONOS3-Mini 的 `gguf/` 資料夾（Apache-2.0）

```
models/zonos/backbone-ptq.gguf
models/zonos/zac-keep2.gguf
models/zonos/spk-encoder.gguf
models/zonos/steer.gguf
```

## Qwen3-TTS VoiceDesign（`models/qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/`）
來源：https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign（Apache-2.0），整個 repo 照原本的資料夾結構放

```
models/qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/config.json
models/qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/model.safetensors
models/qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/speech_tokenizer/model.safetensors
…（其他設定檔）
```

模型想放在別的磁碟：在 repo 根目錄建 `cheruno.local.json`，例如

```json
{ "zonosModels": "D:\models\zonos", "qwenModel": "D:\models\Qwen3-TTS-12Hz-1.7B-VoiceDesign" }
```

可以覆蓋的項目見 `audio/cheruno_audio/paths.py`。
