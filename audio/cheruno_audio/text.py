"""送進 TTS 前的文字處理：{漢字|よみ} 換成讀み、voice 換成各引擎的寫法。"""

import re

RUBY = re.compile(r"\{([^{}|]+)\|([^{}|]+)\}")

VOICES = ("normal", "whisper", "breath")

# Irodori-TTS 的 emoji 風格標記（EMOJI_ANNOTATIONS.md）：👂＝囁き・耳元、😮‍💨＝吐息
IRODORI_VOICE_PREFIX = {"normal": "", "soft": "👂", "whisper": "👂", "breath": "😮‍💨"}  # Irodori 沒有「小聲」：和耳語同一個前綴


SPAN_MARKS = str.maketrans("", "", "《》")  # 句中耳語的範圍標記（core tone.ts whisperSpans）：不念、不顯示


def to_reading(text: str) -> str:
    """{漢字|よみ} → よみ、拿掉《》。TTS 沒有辭典，難讀字用讀み念才穩。core 的 whisperSpans 用同樣的規則算範圍位置"""
    return RUBY.sub(lambda m: m.group(2), text).translate(SPAN_MARKS)


def to_surface(text: str) -> str:
    """{漢字|よみ} → 漢字、拿掉《》（字幕用）。"""
    return RUBY.sub(lambda m: m.group(1), text).translate(SPAN_MARKS)


def irodori_text(text: str, voice: str) -> str:
    if voice not in IRODORI_VOICE_PREFIX:
        raise ValueError(f"未知的 voice：{voice}")
    return IRODORI_VOICE_PREFIX[voice] + to_reading(text)
