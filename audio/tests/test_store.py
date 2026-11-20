import base64
import hashlib
import io
import sqlite3
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from cheruno_audio.server import create_app
from cheruno_audio.store import voice_key

META = {"engine": "zonos", "speaker": "c_1", "seed": 1, "steps": None, "voice": "normal", "text": "こんばんは"}
VKEY = voice_key(**META)


def wav_b64(seconds: float = 0.5) -> str:
    buf = io.BytesIO()
    sf.write(buf, np.zeros(int(16000 * seconds), dtype=np.float32), 16000, format="WAV", subtype="PCM_16")
    return base64.b64encode(buf.getvalue()).decode()


def client() -> tuple[TestClient, Path]:
    d = Path(tempfile.mkdtemp(prefix="cheruno-store-"))
    return TestClient(create_app({}, data_dir=d)), d


def new_save(c: TestClient, data: dict | None = None) -> str:
    return c.post("/store/saves", json={"name": "x", "data": data or {}}).json()["id"]


def test_no_data_dir_is_503():
    r = TestClient(create_app({}, data_dir=None)).get("/store/saves")
    assert r.status_code == 503 and "還沒選存檔區" in r.json()["detail"]


def test_empty_root_has_no_saves_and_no_settings():
    c, _ = client()
    assert c.get("/store/saves").json() == []
    assert c.get("/store/settings").json() == {"settings": None}


def test_settings_roundtrip():
    c, d = client()
    assert c.put("/store/settings", json={"engine": "zonos"}).status_code == 200
    assert c.get("/store/settings").json() == {"settings": {"engine": "zonos"}}
    assert (d / "settings.json").is_file()


def test_save_lifecycle():
    c, d = client()
    sid = new_save(c, {"characters": []})
    assert [m["id"] for m in c.get("/store/saves").json()] == [sid]
    assert (d / "saves" / f"{sid}.json").is_file()  # 一個存檔＝一個 JSON
    got = c.get(f"/store/saves/{sid}").json()
    assert got["data"] == {"characters": []} and got["session"] is None
    assert c.put(f"/store/saves/{sid}/data", json={"characters": [{"id": "c1"}]}).status_code == 200
    assert c.put(f"/store/saves/{sid}/session", json={"msgs": [1]}).status_code == 200
    got = c.get(f"/store/saves/{sid}").json()
    assert got["data"]["characters"][0]["id"] == "c1" and got["session"] == {"msgs": [1]}
    assert c.patch(f"/store/saves/{sid}", json={"name": "改名"}).json()["name"] == "改名"
    trashed = Path(c.delete(f"/store/saves/{sid}").json()["trashed"])
    assert trashed.is_file() and "改名" in trashed.read_text(encoding="utf-8")  # 刪除＝移到 trash，資料還在
    assert c.get("/store/saves").json() == []
    assert c.get(f"/store/saves/{sid}").status_code == 404


def test_bad_ids_and_bodies():
    c, _ = client()
    assert c.get("/store/saves/a.b").status_code == 400
    sid = new_save(c)
    assert c.put(f"/store/saves/{sid}/data", content=b"[1,2]", headers={"Content-Type": "application/json"}).status_code == 400
    assert c.get(f"/store/library/sfx/{'0' * 64}").status_code == 400
    assert c.get("/store/library/voice/xyz").status_code == 400


def test_voice_library_shared_and_indexed():
    c, d = client()
    b64 = wav_b64(0.5)
    r = c.put(f"/store/library/voice/{VKEY}", json={**META, "data_base64": b64})
    assert r.status_code == 200 and r.json()["seconds"] == 0.5
    assert c.put(f"/store/library/voice/{VKEY}", json={**META, "data_base64": b64}).status_code == 200  # 第二個存檔出現同一句
    assert len(list((d / "library" / "voice").glob("*.wav"))) == 1  # 只存一份
    rows = sqlite3.connect(d / "library" / "library.db").execute("SELECT kind, key FROM assets").fetchall()
    assert rows == [("voice", VKEY)]
    got = c.get(f"/store/library/voice/{VKEY}")
    assert got.status_code == 200 and got.content == base64.b64decode(b64) and got.headers["content-type"] == "audio/wav"


def test_voice_key_must_match_params():
    c, _ = client()
    wrong = voice_key("zonos", "c_1", 2, None, "normal", "こんばんは")
    r = c.put(f"/store/library/voice/{wrong}", json={**META, "data_base64": wav_b64()})
    assert r.status_code == 400 and "對不上" in r.json()["detail"]
    assert c.put(f"/store/library/voice/{VKEY}", json={**META, "data_base64": base64.b64encode(b"ID3xx").decode()}).status_code == 400
    assert c.get(f"/store/library/voice/{'0' * 64}").status_code == 404


def test_image_key_is_content_hash():
    c, _ = client()
    png = b"\x89PNG\r\n\x1a\nfake"
    r = c.post("/store/library/image", json={"ext": "png", "data_base64": base64.b64encode(png).decode()})
    assert r.json()["key"] == hashlib.sha256(png).hexdigest()
    assert c.get(f"/store/library/image/{r.json()['key']}").content == png
    assert c.post("/store/library/image", json={"ext": "exe", "data_base64": "AA=="}).status_code == 400
    assert c.post("/store/library/voice", json={"ext": "wav", "data_base64": wav_b64()}).status_code == 400  # 語音要走 PUT（key 由參數算）


def test_unused_list_and_cleanup():
    c, d = client()
    c.put(f"/store/library/voice/{VKEY}", json={**META, "data_base64": wav_b64()})
    other = voice_key("zonos", "c_1", 1, None, "normal", "おやすみ")
    c.put(f"/store/library/voice/{other}", json={**META, "text": "おやすみ", "data_base64": wav_b64()})
    sid = new_save(c)
    c.put(f"/store/saves/{sid}/session", json={"msgs": [{"items": [{"voiceKey": VKEY}]}]})
    lst = c.get("/store/library").json()
    used = {i["key"]: i["used"] for i in lst["items"]}
    assert used == {VKEY: True, other: False} and lst["unusedBytes"] > 0
    assert c.delete(f"/store/library/voice/{VKEY}").status_code == 409  # 存檔還在用
    assert c.delete(f"/store/library/voice/{other}").status_code == 200
    assert (d / "trash" / "library" / "voice" / f"{other}.wav").is_file()  # 清理＝移到 trash
    assert [i["key"] for i in c.get("/store/library").json()["items"]] == [VKEY]
    c.delete(f"/store/saves/{sid}")  # 刪存檔不刪庫檔
    assert (d / "library" / "voice" / f"{VKEY}.wav").is_file()


def test_request_log_is_saved_per_save():
    c, root = client()
    sid = c.post("/store/saves", json={"name": "a", "data": {}, "session": None}).json()["id"]
    assert c.get(f"/store/saves/{sid}/requests").json() == []
    for i in range(105):
        assert c.post(f"/store/saves/{sid}/requests", json={"id": f"r{i}", "purpose": "台詞", "state": "done"}).json() == {"ok": True}
    got = c.get(f"/store/saves/{sid}/requests").json()
    assert [e["id"] for e in got] == [f"r{i}" for i in range(104, 4, -1)]  # 只留最近 100 筆，新的在前
    assert len((root / "requests" / f"{sid}.jsonl").read_text(encoding="utf-8").splitlines()) == 100
    assert c.delete(f"/store/saves/{sid}/requests").json()["trashed"]
    assert c.get(f"/store/saves/{sid}/requests").json() == []
    assert c.get("/store/saves/s_nope/requests").status_code in (400, 404)


def test_app_event_log_batches_and_keeps_500():
    c, root = client()
    sid = c.post("/store/saves", json={"name": "a", "data": {}, "session": None}).json()["id"]
    batch = [{"t": i, "ev": "line.status"} for i in range(520)]
    assert c.post(f"/store/saves/{sid}/events", json=batch).json() == {"ok": True}  # 一次送一批
    got = c.get(f"/store/saves/{sid}/events").json()
    assert len(got) == 500 and got[0]["t"] == 519 and got[-1]["t"] == 20
    assert c.post(f"/store/saves/{sid}/events", json=[1, 2]).status_code == 400

