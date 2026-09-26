"""Controlled corruption injector used to demonstrate and test the auditor."""
from __future__ import annotations

import random
from pathlib import Path

from .store import Dataset


def corrupt(root, *, seed: int = 99, orphan_docs: int = 2,
            stale_postings: int = 3, drop_postings: int = 3,
            drop_lexicon: int = 2, extra_lexicon: int = 2, df_drift: int = 3,
            delete_files: int = 1, stat_drift: bool = True) -> list[str]:
    rng = random.Random(seed)
    root = Path(root)
    ds = Dataset.load(root)
    docs = ds.docstore["docs"]
    postings = ds.index["postings"]
    terms = ds.lexicon["terms"]
    actions: list[str] = []

    pool = sorted(docs)

    # 1. Delete docs from the store + disk but keep their postings (orphans).
    victims = rng.sample(pool, min(orphan_docs, len(pool)))
    for doc_id in victims:
        rel = docs.pop(doc_id)["path"]
        target = root / rel
        if target.exists():
            target.unlink()
        actions.append(f"orphan-doc: removed {doc_id} from docstore+disk, kept postings")
    pool = [d for d in pool if d not in victims]

    # 2. Delete doc files but keep the docstore entry.
    for doc_id in rng.sample(pool, min(delete_files, len(pool))):
        target = root / docs[doc_id]["path"]
        if target.exists():
            target.unlink()
            actions.append(f"missing-file: deleted {docs[doc_id]['path']}, kept docstore entry")

    # 3. Stale postings: reference docs that do not contain the term.
    candidates = [(t, d) for t in sorted(postings) for d in pool
                  if d not in postings[t]]
    for term, doc_id in rng.sample(candidates, min(stale_postings, len(candidates))):
        postings[term].append(doc_id)
        postings[term].sort()
        actions.append(f"stale-posting: added ({term}, {doc_id})")

    # 4. Dropped postings.
    candidates = [(t, d) for t in sorted(postings) for d in postings[t]
                  if len(postings[t]) > 1]
    for term, doc_id in rng.sample(candidates, min(drop_postings, len(candidates))):
        postings[term].remove(doc_id)
        actions.append(f"dropped-posting: removed ({term}, {doc_id})")

    # 5. Lexicon entries removed while the index keeps the term.
    for term in rng.sample(sorted(terms), min(drop_lexicon, len(terms))):
        del terms[term]
        actions.append(f"dropped-lexicon-entry: {term}")

    # 6. Ghost lexicon entries.
    for i in range(extra_lexicon):
        ghost = f"ghost{i:03d}"
        next_id = max(e["term_id"] for e in terms.values()) + 1
        terms[ghost] = {"term_id": next_id, "df": 0}
        actions.append(f"ghost-lexicon-entry: {ghost}")

    # 7. df drift.
    for term in rng.sample(sorted(terms), min(df_drift, len(terms))):
        terms[term]["df"] += 3
        actions.append(f"df-drift: {term} df -> {terms[term]['df']}")

    # 8. Statistics drift.
    if stat_drift:
        ds.stats["total_tokens"] += 17
        ds.stats["num_docs"] += 1
        actions.append("stat-drift: total_tokens += 17, num_docs += 1")

    ds.save()
    return actions
