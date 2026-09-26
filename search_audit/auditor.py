"""Read-only consistency auditor.

Cross-checks the lexicon, inverted index, document store and statistics
against each other and against the raw UTF-8 documents.  The auditor never
writes to the dataset.

De-duplication rule: an issue is keyed by (kind, term, doc, stat).  The same
root problem surfaced by several tables (e.g. a deleted document referenced
by many posting lists, which also skews df and stats) is reported exactly
once, with every table that evidences it merged into ``sources``.
"""
from __future__ import annotations

from dataclasses import dataclass

from .store import DOCS_DIR, Dataset
from .tokenizer import tokenize


@dataclass(frozen=True)
class Issue:
    kind: str
    detail: str
    term: str | None = None
    doc: str | None = None
    stat: str | None = None
    sources: tuple[str, ...] = ()

    @property
    def key(self) -> tuple:
        return (self.kind, self.term, self.doc, self.stat)

    @property
    def subject(self) -> str:
        parts = []
        if self.term is not None:
            parts.append(f"term={self.term!r}")
        if self.doc is not None:
            parts.append(f"doc={self.doc}")
        if self.stat is not None:
            parts.append(f"stat={self.stat}")
        return ", ".join(parts)


@dataclass
class AuditReport:
    issues: list[Issue]

    @property
    def ok(self) -> bool:
        return not self.issues

    def counts_by_kind(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for issue in self.issues:
            counts[issue.kind] = counts.get(issue.kind, 0) + 1
        return dict(sorted(counts.items()))


def _add(issues: dict, kind: str, detail: str, *,
         term=None, doc=None, stat=None, source: str) -> None:
    key = (kind, term, doc, stat)
    existing = issues.get(key)
    if existing is None:
        issues[key] = Issue(kind, detail, term, doc, stat, (source,))
    elif source not in existing.sources:
        issues[key] = Issue(kind, existing.detail, term, doc, stat,
                            existing.sources + (source,))


def audit(root) -> AuditReport:
    ds = Dataset.load(root)
    issues: dict[tuple, Issue] = {}
    store_docs = ds.docstore.get("docs", {})
    postings = ds.index.get("postings", {})
    lex_terms = ds.lexicon.get("terms", {})

    # 1. Recompute postings and lengths from the raw UTF-8 documents.
    recomputed: dict[str, set[str]] = {}
    unreadable: set[str] = set()
    for doc_id, meta in sorted(store_docs.items()):
        path = ds.root / meta["path"]
        if not path.is_file():
            _add(issues, "MISSING_DOC_FILE",
                 f"docstore entry points to missing file {meta['path']!r}",
                 doc=doc_id, source="docstore")
            unreadable.add(doc_id)
            continue
        tokens = tokenize(path.read_text(encoding="utf-8"))
        if meta.get("length") != len(tokens):
            _add(issues, "DOC_LENGTH_MISMATCH",
                 f"docstore length {meta.get('length')} != recomputed {len(tokens)}",
                 doc=doc_id, source="docstore")
        for term in set(tokens):
            recomputed.setdefault(term, set()).add(doc_id)

    # 2. Files on disk that the docstore does not know about.
    stored_paths = {meta["path"] for meta in store_docs.values()}
    docs_dir = ds.root / DOCS_DIR
    if docs_dir.is_dir():
        for file in sorted(docs_dir.glob("*.txt")):
            rel = f"{DOCS_DIR}/{file.name}"
            if rel not in stored_paths:
                _add(issues, "ORPHAN_DOC_FILE",
                     f"file {rel!r} is not registered in the docstore",
                     doc=file.stem, source="filesystem")

    # 3. Inverted index vs docstore: orphans and duplicate postings.
    referenced: dict[str, list[str]] = {}
    for term, plist in sorted(postings.items()):
        seen: set[str] = set()
        for doc_id in plist:
            if doc_id in seen:
                _add(issues, "DUPLICATE_POSTING",
                     "posting list contains the same doc twice",
                     term=term, doc=doc_id, source="inverted_index")
            seen.add(doc_id)
            referenced.setdefault(doc_id, []).append(term)
    for doc_id in sorted(set(referenced) - set(store_docs)):
        terms = referenced[doc_id]
        shown = ", ".join(terms[:5]) + (" ..." if len(terms) > 5 else "")
        _add(issues, "ORPHAN_DOC_REFERENCE",
             f"deleted doc referenced by {len(terms)} posting list(s): {shown}",
             doc=doc_id, source="inverted_index")

    # 4. Inverted index vs recomputed postings.
    for term, docs in sorted(recomputed.items()):
        if term not in postings:
            continue  # reported once as MISSING_INDEX_ENTRY below
        for doc_id in sorted(docs - set(postings[term])):
            _add(issues, "MISSING_POSTING",
                 "doc contains the term but the posting is absent",
                 term=term, doc=doc_id, source="recomputed")
    for term, plist in sorted(postings.items()):
        expected = recomputed.get(term, set())
        for doc_id in sorted(set(plist) - expected):
            if doc_id not in store_docs:
                continue  # already reported once as ORPHAN_DOC_REFERENCE
            if doc_id in unreadable:
                continue  # cannot verify without the file
            _add(issues, "STALE_POSTING",
                 "posting present but the doc does not contain the term",
                 term=term, doc=doc_id, source="inverted_index")

    # 5. Lexicon vs index vs recomputed.
    posting_issue_terms = {
        i.term for i in issues.values()
        if i.kind in ("MISSING_POSTING", "STALE_POSTING", "DUPLICATE_POSTING")
    }
    for term in sorted(set(recomputed) - set(postings)):
        _add(issues, "MISSING_INDEX_ENTRY",
             f"term occurs in {len(recomputed[term])} doc(s) but has no index entry",
             term=term, source="recomputed")
    for term in sorted(set(postings) - set(lex_terms)):
        _add(issues, "MISSING_LEXICON_ENTRY",
             "index term missing from the lexicon",
             term=term, source="inverted_index")
    for term in sorted(set(recomputed) - set(lex_terms)):
        _add(issues, "MISSING_LEXICON_ENTRY",
             "doc term missing from the lexicon",
             term=term, source="recomputed")
    for term in sorted(lex_terms):
        if term not in postings and term not in recomputed:
            _add(issues, "ORPHAN_LEXICON_ENTRY",
                 "lexicon term absent from index and from every stored doc",
                 term=term, source="lexicon")
        elif term in postings and term not in posting_issue_terms:
            # df is only compared when the posting list itself is trusted;
            # otherwise the mismatch is a symptom of the posting issue.
            df = lex_terms[term].get("df")
            if df != len(postings[term]):
                _add(issues, "DF_MISMATCH",
                     f"lexicon df {df} != {len(postings[term])} posting(s) in the index",
                     term=term, source="lexicon")

    # 6. Statistics vs the tables they summarise.
    expected_stats = {
        "num_docs": len(store_docs),
        "num_terms": len(lex_terms),
        "total_tokens": sum(m.get("length", 0) for m in store_docs.values()),
    }
    for name, expected in sorted(expected_stats.items()):
        actual = ds.stats.get(name)
        if actual != expected:
            _add(issues, "STATS_MISMATCH",
                 f"stats.{name} is {actual!r}, expected {expected}",
                 stat=name, source="stats")

    ordered = sorted(issues.values(),
                     key=lambda i: (i.kind, i.term or "", i.doc or "", i.stat or ""))
    return AuditReport(ordered)
