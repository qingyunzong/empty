"""Synthetic dataset generator (local UTF-8 text, deterministic by seed)."""
from __future__ import annotations

import random
from pathlib import Path

from .store import DOCS_DIR, Dataset
from .tokenizer import tokenize

LATIN_VOCAB = [f"term{i:03d}" for i in range(48)]
CJK_VOCAB = ["搜索", "索引", "词典", "文档", "统计", "一致",
             "审计", "修复", "基线", "倒排", "缺失", "孤儿"]
SEPARATORS = [" ", " ", " ", "，", "。", "、", "\n", "！"]


def generate(root, num_docs: int = 40, seed: int = 7) -> Dataset:
    rng = random.Random(seed)
    root = Path(root)
    (root / DOCS_DIR).mkdir(parents=True, exist_ok=True)
    vocab = LATIN_VOCAB + CJK_VOCAB

    docstore: dict = {"docs": {}}
    postings: dict[str, set[str]] = {}
    total_tokens = 0
    for i in range(num_docs):
        doc_id = f"doc_{i:04d}"
        parts: list[str] = []
        for _ in range(rng.randint(20, 60)):
            parts.append(rng.choice(vocab))
            parts.append(rng.choice(SEPARATORS))
        text = "".join(parts)
        rel = f"{DOCS_DIR}/{doc_id}.txt"
        (root / rel).write_text(text, encoding="utf-8")
        tokens = tokenize(text)
        total_tokens += len(tokens)
        docstore["docs"][doc_id] = {"path": rel, "length": len(tokens)}
        for term in set(tokens):
            postings.setdefault(term, set()).add(doc_id)

    index = {"postings": {t: sorted(d) for t, d in sorted(postings.items())}}
    lexicon = {"terms": {
        t: {"term_id": n, "df": len(d)}
        for n, (t, d) in enumerate(sorted(postings.items()))
    }}
    stats = {
        "num_docs": num_docs,
        "num_terms": len(lexicon["terms"]),
        "total_tokens": total_tokens,
    }
    dataset = Dataset(root, docstore, lexicon, index, stats)
    dataset.save()
    return dataset
