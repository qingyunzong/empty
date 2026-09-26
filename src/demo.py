"""End-to-end demo on synthetic UTF-8 documents.

Builds a clean index stack, audits it, injects typical corruption
(deleted docs still referenced by the index, missing files, tampered
counts, ghost entries), audits again, writes a baseline-bound repair
plan, demonstrates that a concurrent modification makes the apply fail,
then applies the plan and audits clean.
"""
from __future__ import annotations

import json
import shutil

from . import builder
from .audit import Auditor
from .repair import BaselineMismatchError, apply_plan, build_plan
from .workspace import Workspace

SAMPLE_DOCS = {
    "d01": "Apples and oranges are fruits. Apples are sweet, oranges are juicy.\n",
    "d02": "OAuth2 tokens expire quickly; refresh tokens persist. Tokens, tokens!\n",
    "d03": "中文分词需要词典，倒排索引记录每个词项的位置。\n",
    "d04": "UTF-8 编码支持多语言混排：中文、English、日本語。\n",
    "d05": "Ｆｕｌｌｗｉｄｔｈ ＴＥＸＴ and Cafe_naive normalize during tokenization.\n",
}


def _edit(ws, name, fn):
    payload = ws.load(name)
    fn(payload)
    ws.save(name, payload)


def run_demo(root):
    ws = Workspace(root)
    if ws.root.exists():
        shutil.rmtree(ws.root)

    print(f"=== 1. create synthetic UTF-8 documents in {ws.docs_dir} ===")
    ws.docs_dir.mkdir(parents=True, exist_ok=True)
    for doc_id, text in SAMPLE_DOCS.items():
        (ws.docs_dir / f"{doc_id}.txt").write_text(text, encoding="utf-8")
        print(f"  {doc_id}.txt: {text.strip()}")

    print("\n=== 2. build components ===")
    version = builder.build(ws)
    print(f"built docstore/lexicon/index/stats at version {version}")

    print("\n=== 3. audit clean state ===")
    print(Auditor(ws).run().render_text())

    print("\n=== 4. inject corruption ===")
    _edit(ws, "docstore", lambda p: p["docs"].pop("d03"))
    print("  - removed d03 from the docstore manifest (file + postings remain)")
    (ws.docs_dir / "d04.txt").unlink()
    print("  - deleted d04.txt (manifest + postings remain)")
    _edit(ws, "lexicon", lambda p: p["terms"]["tokens"].__setitem__("df",
          p["terms"]["tokens"]["df"] + 2))
    print("  - lexicon df of 'tokens' increased by 2")
    _edit(ws, "stats", lambda p: p.__setitem__("total_tokens",
          p["total_tokens"] + 10))
    print("  - stats.total_tokens increased by 10")

    def add_ghost(p):
        p["terms"]["ghostterm"] = {"term_id": "T900001", "df": 2, "cf": 5}
    _edit(ws, "lexicon", add_ghost)
    _edit(ws, "stats", lambda p: p.__setitem__("num_terms", p["num_terms"] + 1))
    print("  - added ghost lexicon entry 'ghostterm' (df=2, no postings)")
    _edit(ws, "index", lambda p: p["postings"].__setitem__("T999999",
          ["d01", "d02"]))
    print("  - added postings for unknown term_id T999999")

    print("\n=== 5. audit corrupted state ===")
    report = Auditor(ws).run()
    print(report.render_text())

    print("\n=== 6. write repair plan (bound to the current baseline) ===")
    plan = build_plan(ws, report)
    plan_path = ws.root / "repair_plan.json"
    plan_path.write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(plan_path.read_text(encoding="utf-8").strip())

    print("\n=== 7. concurrent modification -> apply is refused ===")
    lexicon_path = ws.component_path("lexicon")
    saved = lexicon_path.read_bytes()
    _edit(ws, "lexicon", lambda p: p["terms"]["apples"].__setitem__("cf", 999))
    try:
        apply_plan(ws, plan)
        print("  ERROR: apply should have been refused")
    except BaselineMismatchError as exc:
        print(f"  refused as expected: {exc}")
    lexicon_path.write_bytes(saved)
    print("  (baseline restored)")

    print("\n=== 8. apply plan against the intact baseline ===")
    new_version = apply_plan(ws, plan)
    print(f"applied; components now at version {new_version}")

    print("\n=== 9. final audit ===")
    print(Auditor(ws).run().render_text())
