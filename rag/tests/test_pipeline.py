"""pipeline 測試：自造的假對話資料（三種欄位結構），fake Embedding（不需要 LM Studio）。"""

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import yaml

from cheruno_rag.build import build
from cheruno_rag.cli import main
from cheruno_rag.config import ConfigError, load_config
from cheruno_rag.evaluate import evaluate
from cheruno_rag.inspect_data import inspect
from cheruno_rag.search import Index

TOPICS = [
    ("睡前", "今日もお疲れさま。ゆっくり休んでね。", "うん、そばにいて。おやすみ。"),
    ("料理", "この味噌汁、ちょっと塩を足そうか。", "いいね、出汁の香りがする。"),
    ("雨", "外は雨だね。窓の音、聞こえる？", "うん、雨音って落ち着くね。"),
    ("耳かき", "耳かき、痛くない？ゆっくりするね。", "気持ちいい……そのまま続けて。"),
]


def write_jsonl_messages(p: Path, dup: bool = True):
    rows = []
    for i, (scene, a, b) in enumerate(TOPICS):
        rows.append({"id": f"c{i}", "scene": scene, "messages": [{"role": "system", "content": f"場面：{scene}"}, {"role": "user", "content": a}, {"role": "assistant", "content": b}] * 2})
    rows.append({"id": "short", "scene": "短い", "messages": [{"role": "user", "content": "あ"}]})
    if dup:
        rows.append({**rows[0], "id": "c0-copy"})
    p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")


def write_parquet_sharegpt(p: Path):
    rows = [{"system_prompt": f"場面：{s}", "conversation": [{"from": "human", "value": a}, {"from": "gpt", "value": b}]} for s, a, b in TOPICS]
    pq.write_table(pa.Table.from_pylist(rows), p)


def write_json_nested(p: Path):
    data = {"data": [{"info": {"scene": s}, "dialogue": {"lines": [{"who": "A", "say": a}, {"who": "B", "say": b}]}} for s, a, b in TOPICS]}
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def cfg_file(tmp: Path, name: str, local: str, fields: dict, **extra) -> Path:
    c = {"name": name, "dataset": {"local": [local]}, "fields": fields, "embed": {"backend": "fake"}, **extra}
    p = tmp / f"{name}.yaml"
    p.write_text(yaml.safe_dump(c, allow_unicode=True), encoding="utf-8")
    return p


def test_three_layouts_build(tmp_path):
    write_jsonl_messages(tmp_path / "a.jsonl")
    write_parquet_sharegpt(tmp_path / "b.parquet")
    write_json_nested(tmp_path / "c.json")
    layouts = [
        ("a", "a.jsonl", {"turns": "messages", "id": "id", "meta": {"scene": "scene"}}),
        ("b", "b.parquet", {"turns": "conversation", "role": "from", "content": "value", "system": "system_prompt"}),
        ("c", "c.json", {"turns": "dialogue.lines", "role": "who", "content": "say", "meta": {"scene": "info.scene"}}),
    ]
    for name, f, fields in layouts:
        cfg = load_config(cfg_file(tmp_path, name, f, fields), base_dir=tmp_path)
        rep = build(cfg)
        assert rep["chunks"] >= 4, name
        idx = cfg.out_dir / "index"
        assert (idx / "chunks.jsonl").is_file() and (idx / "embeddings.npy").is_file() and (idx / "manifest.json").is_file()


def test_filters_only_what_config_says(tmp_path):
    write_jsonl_messages(tmp_path / "a.jsonl")
    fields = {"turns": "messages", "meta": {"scene": "scene"}}  # 沒有 id → 內容雜湊，重複的會被去掉
    cfg = load_config(cfg_file(tmp_path, "nofilter", "a.jsonl", fields), base_dir=tmp_path)
    rep = build(cfg)
    assert rep["conversations_kept"] == 5 and rep["rejected_by_reason"] == {"normalize:duplicate_id": 1}  # 沒寫規則：只去掉完全相同的
    cfg2 = load_config(cfg_file(tmp_path, "withfilter", "a.jsonl", {**fields, "id": "id"}, filter=[{"type": "min_chars", "value": 10}, {"type": "dedupe"}, {"type": "where", "key": "scene", "equals": "料理", "negate": True, "name": "料理以外"}]), base_dir=tmp_path)
    rep2 = build(cfg2)
    assert rep2["filter_counts"] == {"1:min_chars": 1, "2:dedupe": 1, "料理以外": 1}
    assert rep2["conversations_kept"] == 3
    rejected = [json.loads(l) for l in (cfg2.out_dir / "rejected.jsonl").read_text(encoding="utf-8").splitlines()]
    assert all("reason" in r and "messages" not in r for r in rejected)  # 淘汰紀錄只有 id＋原因，不重複存內容


def test_deterministic(tmp_path):
    write_jsonl_messages(tmp_path / "a.jsonl")
    p = cfg_file(tmp_path, "det", "a.jsonl", {"turns": "messages", "id": "id"})
    build(load_config(p, base_dir=tmp_path))
    m1 = json.loads((tmp_path / "out/det/index/manifest.json").read_text(encoding="utf-8"))
    build(load_config(p, base_dir=tmp_path))
    m2 = json.loads((tmp_path / "out/det/index/manifest.json").read_text(encoding="utf-8"))
    assert m1["config_hash"] == m2["config_hash"] and m1["files"] == m2["files"]


def test_window_chunks_overlap_and_limit(tmp_path):
    long = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"第{i}句、" + "あ" * 40} for i in range(20)]
    (tmp_path / "l.jsonl").write_text(json.dumps({"id": "L", "messages": long}, ensure_ascii=False), encoding="utf-8")
    cfg = load_config(cfg_file(tmp_path, "win", "l.jsonl", {"turns": "messages", "id": "id"}, chunk={"mode": "window", "turns": 4, "stride": 2, "max_chars": 1000}), base_dir=tmp_path)
    build(cfg)
    chunks = [json.loads(l) for l in (cfg.out_dir / "index/chunks.jsonl").read_text(encoding="utf-8").splitlines()]
    spans = [(c["turn_from"], c["turn_to"]) for c in chunks]
    assert spans[0] == (0, 4) and spans[1] == (2, 6) and spans[-1][1] == 20  # 重疊 2 輪、最後一片到結尾
    cfg2 = load_config(cfg_file(tmp_path, "cap", "l.jsonl", {"turns": "messages", "id": "id"}, chunk={"mode": "conversation", "max_chars": 200}), base_dir=tmp_path)
    build(cfg2)
    chunks2 = [json.loads(l) for l in (cfg2.out_dir / "index/chunks.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(chunks2) > 1 and all(c["n_chars"] <= 200 for c in chunks2)  # 整段太長就切，每片不超過上限
    assert [c["turn_from"] for c in chunks2] == sorted({c["turn_from"] for c in chunks2})  # 不重疊、依序


def test_search_hybrid_keyword_and_eval_red_light(tmp_path, monkeypatch):
    write_jsonl_messages(tmp_path / "a.jsonl", dup=False)
    p = cfg_file(tmp_path, "s", "a.jsonl", {"turns": "messages", "id": "id", "meta": {"scene": "scene"}})
    cfg = load_config(p, base_dir=tmp_path)
    build(cfg)
    idx = Index(cfg.out_dir / "index")
    assert idx.search("雨音が落ち着く", k=1)[0].chunk["conv_id"] == "c2"
    assert idx.search("耳かき 痛くない", k=1, mode="keyword")[0].chunk["conv_id"] == "c3"
    assert idx.search("味噌汁", k=3, filters={"scene": "睡前"})[0].chunk["meta"]["scene"] == "睡前"  # metadata 篩選
    good = tmp_path / "good.jsonl"
    good.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in [{"query": "雨の音", "expect": {"ids": ["c2"]}}, {"query": "味噌汁 塩", "expect": {"meta": {"scene": "料理"}}}]), encoding="utf-8")
    assert evaluate(cfg, good)["hit@1"] == 1.0
    bad = tmp_path / "bad.jsonl"  # 故意放錯答案：要判失敗（先證明會亮紅燈）
    bad.write_text(json.dumps({"query": "雨の音", "expect": {"ids": ["c1"]}}, ensure_ascii=False), encoding="utf-8")
    assert evaluate(cfg, bad)["hit@1"] == 0.0
    mangled = tmp_path / "mangled.jsonl"  # 中日文寫檔時被轉成 ?：要報錯，不能默默算出 0 分
    mangled.write_text(json.dumps({"query": "??? ????", "expect": {"ids": ["c2"]}}), encoding="utf-8")
    with pytest.raises(ValueError, match="轉碼"):
        evaluate(cfg, mangled)
    monkeypatch.chdir(tmp_path)  # CLI 的輸出位置相對於執行資料夾（rag-lab/rag.cmd 會先 cd 進 rag-lab）
    none = tmp_path / "none.jsonl"  # 不存在的答案：前 5 名都不會中（測試資料只有 4 段，錯放成別段仍會落在前 5）
    none.write_text(json.dumps({"query": "雨の音", "expect": {"ids": ["zzz"]}}, ensure_ascii=False), encoding="utf-8")
    assert main(["eval", "--config", str(p), "--file", str(none), "--min-hit5", "0.5"]) == 1  # CLI 門檻：低於就回傳失敗
    assert main(["eval", "--config", str(p), "--file", str(good), "--min-hit5", "0.5"]) == 0


def test_keyword_only_mode(tmp_path):
    write_jsonl_messages(tmp_path / "a.jsonl", dup=False)
    p = cfg_file(tmp_path, "kw", "a.jsonl", {"turns": "messages", "id": "id"}, embed={"backend": "none"}, search={"mode": "keyword"})
    cfg = load_config(p, base_dir=tmp_path)
    build(cfg)
    assert not (cfg.out_dir / "index/embeddings.npy").exists()
    idx = Index(cfg.out_dir / "index")
    assert idx.search("味噌汁", k=1, mode="keyword")[0].chunk["conv_id"] == "c1"
    with pytest.raises(Exception, match="沒有向量"):
        idx.search("味噌汁", mode="hybrid")


def test_bm25_matches_rank_bm25(tmp_path):
    from rank_bm25 import BM25Okapi

    from cheruno_rag import bm25

    docs = [["雨", "の", "音", "雨"], [], ["耳", "かき", "の", "音"], ["の"] * 5, ["味噌汁", "塩", "の"], ["雨", "耳"]]
    bm25.write(docs, tmp_path)
    mine = bm25.Bm25(tmp_path)
    ref = BM25Okapi([t or ["\u0000"] for t in docs])  # 舊做法：空片段當成一個 \0 詞
    for q in (["雨"], ["の"], ["雨", "雨", "音"], ["耳", "かき"], ["沒有"], [], ["の", "味噌汁"]):
        assert mine.scores(q) == pytest.approx(ref.get_scores(q), rel=1e-12, abs=1e-12), q  # 負 idf（「の」）也一樣


def test_old_index_without_bm25_files_errors(tmp_path):
    write_jsonl_messages(tmp_path / "a.jsonl", dup=False)
    cfg = load_config(cfg_file(tmp_path, "old", "a.jsonl", {"turns": "messages", "id": "id"}), base_dir=tmp_path)
    build(cfg)
    idx_dir = cfg.out_dir / "index"
    assert not (idx_dir / "tokens.jsonl").exists() and (idx_dir / "bm25_docs.npy").is_file()
    (idx_dir / "bm25_docs.npy").unlink()
    with pytest.raises(Exception, match="重跑 build"):
        Index(idx_dir)


def test_inspect_reports_structure_without_samples(tmp_path, capsys):
    write_jsonl_messages(tmp_path / "a.jsonl")
    cfg = load_config(cfg_file(tmp_path, "ins", "a.jsonl", {"turns": "messages"}), base_dir=tmp_path)
    inspect(cfg)
    schema = json.loads((cfg.out_dir / "reports/schema.json").read_text(encoding="utf-8"))
    assert "messages[].content" in schema and schema["messages[].role"]["types"] == {"str": 31}
    assert not (cfg.out_dir / "reports/samples.jsonl").exists()  # 沒加 --sample 就不存內容
    out = capsys.readouterr().out
    assert "お疲れさま" not in out  # 畫面上不印內容
    inspect(cfg, sample=2)
    assert len((cfg.out_dir / "reports/samples.jsonl").read_text(encoding="utf-8").splitlines()) == 2


def test_config_errors(tmp_path):
    p = tmp_path / "bad.yaml"
    p.write_text("name: x\ndataset: {local: [a.jsonl]}\nfields: {turns: m, typo_key: 1}\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="typo_key"):
        load_config(p)
    p.write_text("name: x\ndataset: {local: [a.jsonl], hf_repo: a/b}\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="剛好填一個"):
        load_config(p)
    p.write_text("name: x\ndataset: {local: [a.jsonl]}\nembed: {backend: none}\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="keyword"):
        load_config(p)


def test_hf_raw_reads_only_included_data_files(tmp_path):
    """HF 下載資料夾裡的清單檔、.cache 不算資料；設了 include 只讀符合的"""
    from cheruno_rag.download import raw_files

    raw = tmp_path / "out" / "hf" / "raw"
    (raw / "data").mkdir(parents=True)
    (raw / ".cache" / "huggingface").mkdir(parents=True)
    write_jsonl_messages(raw / "data" / "train.jsonl", dup=False)
    (raw / "files_list.json").write_text(json.dumps({"files": ["data/train.jsonl"]}), encoding="utf-8")
    (raw / ".cache" / "huggingface" / "x.json").write_text("{}", encoding="utf-8")
    p = tmp_path / "hf.yaml"
    p.write_text(yaml.safe_dump({"name": "hf", "dataset": {"hf_repo": "a/b", "include": ["data/*"]}, "fields": {"turns": "messages", "id": "id"}, "embed": {"backend": "fake"}}), encoding="utf-8")
    assert [f.name for f in raw_files(load_config(p, base_dir=tmp_path))] == ["train.jsonl"]
    p.write_text(yaml.safe_dump({"name": "hf", "dataset": {"hf_repo": "a/b"}, "fields": {"turns": "messages", "id": "id"}, "embed": {"backend": "fake"}}), encoding="utf-8")
    assert sorted(f.name for f in raw_files(load_config(p, base_dir=tmp_path))) == ["files_list.json", "train.jsonl"]  # 沒設 include：隱藏資料夾仍跳過


def test_embed_resumes_from_cache_after_crash(tmp_path, monkeypatch, capsys):
    """向量每批存快取：中途斷掉重跑只算剩下的；全部算過就不再呼叫；結果和一次跑完相同。"""
    import numpy as np

    from cheruno_rag import build as build_mod
    from cheruno_rag.embed import fake_embed

    monkeypatch.setattr(build_mod, "EMBED_GROUP", 2)
    write_jsonl_messages(tmp_path / "a.jsonl", dup=False)
    calls: list[int] = []

    def make(fail_after: int | None = None):
        def counted(texts):
            if fail_after is not None and len(calls) >= fail_after:
                raise RuntimeError("模擬斷線")
            calls.append(len(texts))
            return fake_embed(texts)
        return counted

    p = cfg_file(tmp_path, "res", "a.jsonl", {"turns": "messages", "id": "id"})
    cfg = load_config(p, base_dir=tmp_path)
    with pytest.raises(RuntimeError, match="模擬斷線"):
        build(cfg, embedder=make(fail_after=1))
    first = sum(calls)
    assert first == 2 and len(list((tmp_path / "out/res/embed_cache").glob("part_*.npz"))) == 1
    calls.clear()
    build(cfg, embedder=make())
    total = len((tmp_path / "out/res/index/chunks.jsonl").read_text(encoding="utf-8").splitlines())
    assert total > first and sum(calls) == total - first
    assert "向量快取已有 2/" in capsys.readouterr().out
    calls.clear()
    build(cfg, embedder=make())
    assert calls == []
    resumed = np.load(tmp_path / "out/res/index/embeddings.npy")
    p2 = cfg_file(tmp_path, "fresh", "a.jsonl", {"turns": "messages", "id": "id"})
    build(load_config(p2, base_dir=tmp_path), embedder=make())
    assert np.array_equal(resumed, np.load(tmp_path / "out/fresh/index/embeddings.npy"))
