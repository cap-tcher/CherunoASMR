import json
import tempfile
from pathlib import Path

import yaml
from fastapi.testclient import TestClient

from cheruno_audio import paths
from cheruno_audio.server import create_app
from cheruno_rag.build import build
from cheruno_rag.config import load_config


def make_index(root: Path, name: str, backend: str = "fake") -> None:
    rows = [{"id": f"c{i}", "scene": s, "messages": [{"role": "user", "content": a}, {"role": "assistant", "content": b}]} for i, (s, a, b) in enumerate([("睡前", "今日もお疲れさま。", "ゆっくり休んでね、おやすみ。"), ("料理", "味噌汁に塩を足そうか。", "出汁の香りがいいね。"), ("雨", "外は雨だね。", "雨音って落ち着くね。")])]
    (root / "d.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
    cfg = {"name": name, "out": str(root / "rag" / name), "dataset": {"local": ["d.jsonl"]}, "fields": {"turns": "messages", "id": "id", "meta": {"scene": "scene"}}, "embed": {"backend": backend}}
    if backend == "none":
        cfg["search"] = {"mode": "keyword"}
    (root / f"{name}.yaml").write_text(yaml.safe_dump(cfg, allow_unicode=True), encoding="utf-8")
    build(load_config(root / f"{name}.yaml", base_dir=root))


def client(monkeypatch, root: Path) -> TestClient:
    monkeypatch.setattr(paths, "_local", lambda: {"ragDir": str(root / "rag")})
    return TestClient(create_app({}, data_dir=Path(tempfile.mkdtemp(prefix="cheruno-rag-"))))


def test_collections_and_search(monkeypatch, tmp_path):
    make_index(tmp_path, "demo")
    c = client(monkeypatch, tmp_path)
    cols = c.get("/rag/collections").json()["collections"]
    assert [x["name"] for x in cols] == ["demo"] and cols[0]["chunks"] == 3
    hits = c.post("/rag/search", json={"collection": "demo", "query": "雨音が落ち着く", "k": 2}).json()["hits"]
    assert hits[0]["id"] == "c2#0" and "text" in hits[0] and hits[0]["meta"]["scene"] == "雨"
    hits = c.post("/rag/search", json={"collection": "demo", "query": "味噌汁", "k": 3, "filters": {"scene": "睡前"}}).json()["hits"]
    assert [h["meta"]["scene"] for h in hits] == ["睡前"]


def test_missing_index_and_keyword_only(monkeypatch, tmp_path):
    make_index(tmp_path, "kw", backend="none")
    c = client(monkeypatch, tmp_path)
    r = c.post("/rag/search", json={"collection": "nope", "query": "x"})
    assert r.status_code == 404 and "先用 rag pipeline build" in r.json()["detail"]
    assert c.post("/rag/search", json={"collection": "kw", "query": "味噌汁"}).json()["hits"][0]["id"] == "c1#0"
    r = c.post("/rag/search", json={"collection": "kw", "query": "味噌汁", "mode": "hybrid"})
    assert r.status_code == 400 and "沒有向量" in r.json()["detail"]


def test_embed_unreachable_is_503(monkeypatch, tmp_path):
    make_index(tmp_path, "lm", backend="fake")
    mf = tmp_path / "rag" / "lm" / "index" / "manifest.json"
    m = json.loads(mf.read_text(encoding="utf-8"))
    m["embed"] = {"backend": "lmstudio", "model": "x", "base_url": "http://127.0.0.1:9", "dim": m["embed"]["dim"]}  # 連不上的位址
    mf.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
    c = client(monkeypatch, tmp_path)
    r = c.post("/rag/search", json={"collection": "lm", "query": "雨", "mode": "vector"})
    assert r.status_code == 503 and "連不上 Embedding" in r.json()["detail"]


def _zip_dir(src: Path, zip_path: Path, arc_root: str) -> bytes:
    import zipfile

    with zipfile.ZipFile(zip_path, "w") as z:
        for f in sorted(src.rglob("*")):
            if f.is_file():
                z.write(f, f"{arc_root}/{f.relative_to(src).as_posix()}" if arc_root else f.relative_to(src).as_posix())
    return zip_path.read_bytes()


def test_import_index_zip(monkeypatch, tmp_path):
    """匯入別處建好的索引：壓整個 <名稱> 資料夾、只壓 index 資料夾都收；匯入後列得出、查得到"""
    src = tmp_path / "src"
    src.mkdir()
    make_index(src, "share", backend="none")
    whole = _zip_dir(src / "rag" / "share", tmp_path / "whole.zip", "share")  # Windows「傳送到壓縮資料夾」的樣子
    only_index = _zip_dir(src / "rag" / "share" / "index", tmp_path / "idx.zip", "")
    dst = tmp_path / "dst"
    dst.mkdir()
    c = client(monkeypatch, dst)
    assert c.get("/rag/collections").json()["collections"] == []
    r = c.post("/rag/import?name=friend", content=whole, headers={"content-type": "application/zip"})
    assert r.status_code == 200 and r.json()["chunks"] == 3, r.text
    r = c.post("/rag/import?name=friend2", content=only_index, headers={"content-type": "application/zip"})
    assert r.status_code == 200, r.text
    assert [x["name"] for x in c.get("/rag/collections").json()["collections"]] == ["friend", "friend2"]
    assert c.post("/rag/search", json={"collection": "friend", "query": "味噌汁"}).json()["hits"][0]["id"] == "c1#0"
    # 同名不覆蓋
    r = c.post("/rag/import?name=friend", content=whole)
    assert r.status_code == 409 and "已經有叫「friend」" in r.json()["detail"]
    assert not [p for p in (dst / "rag").iterdir() if p.name.startswith(".")]  # 沒有殘留暫存


def test_import_rejects_bad_zip(monkeypatch, tmp_path):
    import io as _io
    import zipfile

    c = client(monkeypatch, tmp_path)
    assert c.post("/rag/import?name=x", content=b"not a zip").json()["detail"] == "不是 zip 檔"
    b = _io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("readme.txt", "hi")
    r = c.post("/rag/import?name=x", content=b.getvalue())
    assert r.status_code == 400 and "manifest.json" in r.json()["detail"]
    b = _io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("../evil/manifest.json", "{}")
    r = c.post("/rag/import?name=x", content=b.getvalue())
    assert r.status_code == 400 and "不安全的路徑" in r.json()["detail"]
    assert not (tmp_path / "evil").exists()
    b = _io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("x/index/manifest.json", "{\"broken\": true}")
    r = c.post("/rag/import?name=x", content=b.getvalue())
    assert r.status_code == 400 and "讀不起來" in r.json()["detail"]
    assert c.post("/rag/import?name=bad name", content=b"x").status_code == 422
    assert not (tmp_path / "rag" / "x").exists()
    assert not [p for p in (tmp_path / "rag").iterdir() if p.name.startswith(".")]


def test_open_folder_local_only(monkeypatch, tmp_path):
    import os

    opened = []
    monkeypatch.setattr(os, "startfile", lambda p: opened.append(p), raising=False)
    c = client(monkeypatch, tmp_path)
    r = c.post("/rag/open-folder")
    assert r.status_code == 200 and opened == [str(tmp_path / "rag")] and (tmp_path / "rag").is_dir()
    remote = TestClient(c.app, client=("tablet.example", 5000))  # 區網裡的別台裝置（不寫 IP：個資掃描不收 IP 字面值）
    assert remote.post("/rag/open-folder").status_code == 403
