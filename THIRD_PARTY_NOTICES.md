# 第三方元件

CherunoASMR 本身是 MIT 授權（見 `LICENSE`）。下面這些不在這個 repo 裡，由 `startserver.bat` 在你的電腦上下載，各自依原本的授權使用。

| 元件 | 用途 | 授權 | 來源 |
|---|---|---|---|
| ZONOS3-Mini 伺服器（ggml 版） | 每句台詞的語音合成 | MIT（Zyphra, Inc.）；內含元件見壓縮檔裡的 `NOTICE`、`third_party/licenses/` | https://github.com/Zyphra/ZONOS3-Mini |
| ggml | ZONOS 伺服器的運算函式庫 | MIT | https://github.com/ggml-org/ggml |
| NVIDIA CUDA 執行檔（cudart、cuBLAS） | ZONOS 伺服器用顯卡運算 | NVIDIA CUDA Toolkit EULA（可再散布的元件） | https://docs.nvidia.com/cuda/eula/ |
| ZONOS3-Mini 模型 | 同上 | Apache-2.0 | https://huggingface.co/Zyphra/ZONOS3-Mini |
| Qwen3-TTS VoiceDesign 模型 | 依文字描述設計聲音 | Apache-2.0 | https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign |
| qwen-tts | 載入 Qwen3-TTS 的 Python 套件 | Apache-2.0 | https://pypi.org/project/qwen-tts/ |
| PyTorch | Qwen3-TTS 的運算 | BSD-3-Clause | https://pytorch.org |
| FFmpeg（gyan.dev essentials build） | ZONOS 登錄聲音時解碼音檔 | GPL-3.0 | https://github.com/GyanD/codexffmpeg |
| Node.js | 跑 app | MIT | https://nodejs.org |
| uv | 安裝 Python 與套件 | MIT／Apache-2.0 | https://github.com/astral-sh/uv |

app 與音訊服務用到的 npm、Python 套件列在 `package-lock.json`、`audio/uv.lock`、`tts/qwen/uv.lock`。
