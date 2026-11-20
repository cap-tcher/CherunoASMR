import json
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from cheruno_audio.server import create_app


def tmp() -> Path:
    return Path(tempfile.mkdtemp(prefix="cheruno-dd-"))


def client(cfg: Path) -> TestClient:
    return TestClient(create_app({}, config_file=cfg))


def test_unset_then_choose_then_persists(monkeypatch):
    monkeypatch.delenv("CHERUNO_DATA_DIR", raising=False)
    base = tmp()
    cfg = base / "cfg" / "config.json"
    c = client(cfg)
    assert c.get("/store/datadir").json()["dataDir"] is None
    assert c.get("/store/info").status_code == 503  # 還沒選
    assert c.post("/store/datadir", json={"path": "relative/dir"}).status_code == 400
    target = base / "新的存檔區"
    res = c.post("/store/datadir", json={"path": str(target)}).json()
    assert res["dataDir"] == str(target.resolve())
    assert target.is_dir() and json.loads(cfg.read_text(encoding="utf-8"))["dataDir"] == str(target.resolve())
    assert c.get("/store/info").json()["dataDir"] == str(target.resolve())  # 不用重啟就切過去
    assert client(cfg).get("/store/datadir").json()["dataDir"] == str(target.resolve())  # 重啟後還記得


def test_pick_switches_or_cancels():
    base = tmp()
    cfg = base / "config.json"
    target = base / "選的資料夾"
    calls = []

    def fake_pick(initial):
        calls.append(initial)
        return str(target) if len(calls) == 1 else None

    c = TestClient(create_app({}, config_file=cfg, pick_dir=fake_pick))
    res = c.post("/store/datadir/pick").json()
    assert res["cancelled"] is False and res["dataDir"] == str(target.resolve()) and target.is_dir()
    res2 = c.post("/store/datadir/pick").json()  # 第二次取消：不動
    assert res2["cancelled"] is True and res2["dataDir"] == str(target.resolve())
    assert calls == [None, target.resolve()]  # 視窗從目前的存檔區開始


def test_env_locks(monkeypatch):
    d = tmp()
    monkeypatch.setenv("CHERUNO_DATA_DIR", str(d))
    c = client(tmp() / "config.json")
    assert c.get("/store/datadir").json() == {"dataDir": str(d), "locked": "env", "configFile": c.get("/store/datadir").json()["configFile"]}
    assert c.post("/store/datadir", json={"path": str(tmp())}).status_code == 409
    assert TestClient(create_app({}, config_file=tmp() / "c.json", pick_dir=lambda _: (_ for _ in ()).throw(AssertionError("鎖定時不該開視窗")))).post("/store/datadir/pick").status_code == 409
