"""Builds the four components from the physical document files."""
from __future__ import annotations

import hashlib

from .tokenizer import tokenize
from .workspace import Workspace


def _term_id(seq: int) -> str:
    return f"T{seq:06d}"


def build(ws: Workspace) -> int:
    """Rebuild docstore/lexicon/index/stats from ``data/docs/*.txt``.

    Returns the new shared version (previous common version + 1, or 1).
    """
    docs = {}
    if ws.docs_dir.exists():
        for path in sorted(ws.docs_dir.glob("*.txt")):
            docs[path.stem] = tokenize(path.read_text(encoding="utf-8"))
    version = (ws.common_version() or 0) + 1

    docstore = {"version": version, "docs": {}}
    for doc_id, tokens in docs.items():
        raw = (ws.docs_dir / f"{doc_id}.txt").read_bytes()
        docstore["docs"][doc_id] = {
            "file": f"docs/{doc_id}.txt",
            "sha256": hashlib.sha256(raw).hexdigest(),
            "num_tokens": len(tokens),
        }

    terms = sorted({token for tokens in docs.values() for token in tokens})
    lexicon = {"version": version, "terms": {}}
    for seq, term in enumerate(terms, start=1):
        lexicon["terms"][term] = {"term_id": _term_id(seq), "df": 0, "cf": 0}

    index = {"version": version, "postings": {}}
    for doc_id, tokens in docs.items():
        for term in set(tokens):
            entry = lexicon["terms"][term]
            entry["df"] += 1
            index["postings"].setdefault(entry["term_id"], []).append(doc_id)
        for term in tokens:
            lexicon["terms"][term]["cf"] += 1
    for doc_ids in index["postings"].values():
        doc_ids.sort()

    stats = {
        "version": version,
        "num_docs": len(docs),
        "num_terms": len(terms),
        "total_tokens": sum(len(tokens) for tokens in docs.values()),
    }

    ws.save("docstore", docstore)
    ws.save("lexicon", lexicon)
    ws.save("index", index)
    ws.save("stats", stats)
    return version
