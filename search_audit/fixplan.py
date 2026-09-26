"""Fix-plan generation, application and baseline validation.

The auditor itself is read-only.  A fix plan is an ordered list of
idempotent operations derived from the audited issues.  Validation copies
the dataset to a scratch directory (the baseline on disk stays untouched),
applies the plan, re-audits, and diffs the result against the baseline:
every mutation must trace back to an audited issue, otherwise validation
fails.
"""
from __future__ import annotations

import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .auditor import AuditReport, Issue, audit
from .store import DOCS_DIR, Dataset
from .tokenizer import tokenize

# Issue kinds whose fix changes num_docs / num_terms / total_tokens.
_STATS_AFFECTING = {
    "STATS_MISMATCH",
    "MISSING_DOC_FILE",
    "ORPHAN_DOC_FILE",
    "DOC_LENGTH_MISMATCH",
    "MISSING_LEXICON_ENTRY",
    "ORPHAN_LEXICON_ENTRY",
}


def build_plan(root) -> tuple[list[dict], AuditReport]:
    report = audit(root)
    ds = Dataset.load(root)
    postings = ds.index.get("postings", {})
    structural: list[dict] = []
    lexicon_ops: list[dict] = []
    touched_terms: set[str] = set()

    def terms_holding(doc_id: str) -> set[str]:
        return {t for t, plist in postings.items() if doc_id in plist}

    for issue in report.issues:
        kind = issue.kind
        if kind == "ORPHAN_DOC_REFERENCE":
            structural.append({"op": "remove_doc_from_index", "doc": issue.doc})
            touched_terms |= terms_holding(issue.doc)
        elif kind == "STALE_POSTING":
            structural.append({"op": "remove_posting",
                               "term": issue.term, "doc": issue.doc})
            touched_terms.add(issue.term)
        elif kind == "MISSING_POSTING":
            structural.append({"op": "add_posting",
                               "term": issue.term, "doc": issue.doc})
            touched_terms.add(issue.term)
        elif kind == "MISSING_INDEX_ENTRY":
            structural.append({"op": "rebuild_term_entry", "term": issue.term})
            touched_terms.add(issue.term)
        elif kind == "DUPLICATE_POSTING":
            structural.append({"op": "dedupe_postings", "term": issue.term})
            touched_terms.add(issue.term)
        elif kind == "MISSING_LEXICON_ENTRY":
            lexicon_ops.append({"op": "add_lexicon_entry", "term": issue.term})
            touched_terms.add(issue.term)
        elif kind == "ORPHAN_LEXICON_ENTRY":
            lexicon_ops.append({"op": "remove_lexicon_entry", "term": issue.term})
        elif kind == "DF_MISMATCH":
            touched_terms.add(issue.term)
        elif kind == "DOC_LENGTH_MISMATCH":
            structural.append({"op": "fix_doc_length", "doc": issue.doc})
        elif kind == "MISSING_DOC_FILE":
            structural.append({"op": "purge_doc", "doc": issue.doc})
            touched_terms |= terms_holding(issue.doc)
        elif kind == "ORPHAN_DOC_FILE":
            structural.append({"op": "ingest_file", "doc": issue.doc})
        elif kind == "STATS_MISMATCH":
            pass  # handled by the trailing recompute_stats op
        else:  # pragma: no cover - defensive
            raise ValueError(f"no fix known for issue kind {kind}")

    plan = structural + lexicon_ops
    if touched_terms:
        plan.append({"op": "recompute_df", "terms": sorted(touched_terms)})
    if any(i.kind in _STATS_AFFECTING for i in report.issues):
        plan.append({"op": "recompute_stats"})
    return plan, report


def apply_plan(root, plan: list[dict]) -> None:
    ds = Dataset.load(root)
    docs = ds.docstore.setdefault("docs", {})
    postings = ds.index.setdefault("postings", {})
    terms = ds.lexicon.setdefault("terms", {})

    def add_lexicon(term: str) -> None:
        if term not in terms:
            next_id = max((e.get("term_id", -1) for e in terms.values()),
                          default=-1) + 1
            terms[term] = {"term_id": next_id,
                           "df": len(postings.get(term, []))}

    for op in plan:
        action = op["op"]
        if action == "remove_doc_from_index":
            for plist in postings.values():
                while op["doc"] in plist:
                    plist.remove(op["doc"])
        elif action == "remove_posting":
            plist = postings.get(op["term"], [])
            while op["doc"] in plist:
                plist.remove(op["doc"])
        elif action == "add_posting":
            plist = postings.setdefault(op["term"], [])
            if op["doc"] not in plist:
                plist.append(op["doc"])
                plist.sort()
        elif action == "rebuild_term_entry":
            term = op["term"]
            holders = []
            for doc_id, meta in sorted(docs.items()):
                path = ds.root / meta["path"]
                if path.is_file() and term in set(
                        tokenize(path.read_text(encoding="utf-8"))):
                    holders.append(doc_id)
            postings[term] = holders
        elif action == "dedupe_postings":
            postings[op["term"]] = sorted(set(postings.get(op["term"], [])))
        elif action == "add_lexicon_entry":
            add_lexicon(op["term"])
        elif action == "remove_lexicon_entry":
            terms.pop(op["term"], None)
        elif action == "fix_doc_length":
            meta = docs[op["doc"]]
            tokens = tokenize((ds.root / meta["path"]).read_text(encoding="utf-8"))
            meta["length"] = len(tokens)
        elif action == "purge_doc":
            docs.pop(op["doc"], None)
            for plist in postings.values():
                while op["doc"] in plist:
                    plist.remove(op["doc"])
        elif action == "ingest_file":
            doc_id = op["doc"]
            rel = f"{DOCS_DIR}/{doc_id}.txt"
            tokens = tokenize((ds.root / rel).read_text(encoding="utf-8"))
            docs[doc_id] = {"path": rel, "length": len(tokens)}
            for term in set(tokens):
                plist = postings.setdefault(term, [])
                if doc_id not in plist:
                    plist.append(doc_id)
                    plist.sort()
                add_lexicon(term)
                terms[term]["df"] = len(postings[term])
        elif action == "recompute_df":
            for term in op["terms"]:
                if term in terms and term in postings:
                    terms[term]["df"] = len(postings[term])
        elif action == "recompute_stats":
            ds.stats.clear()
            ds.stats.update({
                "num_docs": len(docs),
                "num_terms": len(terms),
                "total_tokens": sum(m.get("length", 0) for m in docs.values()),
            })
        else:  # pragma: no cover - defensive
            raise ValueError(f"unknown op {action}")
    ds.save()


@dataclass
class ValidationResult:
    applied_ops: int
    residual_issues: list[Issue]
    unexpected_changes: list[str]

    @property
    def ok(self) -> bool:
        return not self.residual_issues and not self.unexpected_changes


def validate_plan(root, plan: list[dict]) -> ValidationResult:
    root = Path(root)
    baseline = Dataset.load(root)
    report = audit(root)
    allowed_terms = {i.term for i in report.issues if i.term}
    allowed_docs = {i.doc for i in report.issues if i.doc}
    allowed_pairs = {(i.term, i.doc) for i in report.issues if i.term and i.doc}
    allow_stats = any(i.kind in _STATS_AFFECTING for i in report.issues)

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "dataset"
        shutil.copytree(root, work)
        apply_plan(work, plan)
        residual = audit(work).issues
        fixed = Dataset.load(work)

    unexpected = _diff_against_baseline(
        baseline, fixed,
        allowed_terms=allowed_terms,
        allowed_docs=allowed_docs,
        allowed_pairs=allowed_pairs,
        allow_stats=allow_stats,
    )
    return ValidationResult(len(plan), residual, unexpected)


def _diff_against_baseline(baseline: Dataset, fixed: Dataset, *,
                           allowed_terms: set, allowed_docs: set,
                           allowed_pairs: set, allow_stats: bool) -> list[str]:
    unexpected: list[str] = []

    b_docs = baseline.docstore.get("docs", {})
    f_docs = fixed.docstore.get("docs", {})
    for doc_id in sorted(set(b_docs) ^ set(f_docs)):
        if doc_id not in allowed_docs:
            unexpected.append(f"docstore entry added/removed for unflagged doc {doc_id}")
    for doc_id in sorted(set(b_docs) & set(f_docs)):
        if b_docs[doc_id] != f_docs[doc_id] and doc_id not in allowed_docs:
            unexpected.append(f"docstore metadata changed for unflagged doc {doc_id}")

    b_post = baseline.index.get("postings", {})
    f_post = fixed.index.get("postings", {})
    posting_changed_terms: set[str] = set()
    for term in sorted(set(b_post) | set(f_post)):
        b_list = b_post.get(term, [])
        f_list = f_post.get(term, [])
        if b_list == f_list:
            continue
        posting_changed_terms.add(term)
        if term not in b_post and term not in allowed_terms \
                and not any(d in allowed_docs for d in f_list):
            unexpected.append(f"index entry created for unflagged term {term!r}")
        for doc_id in sorted(set(b_list) ^ set(f_list)):
            if doc_id in allowed_docs or (term, doc_id) in allowed_pairs \
                    or term in allowed_terms:
                continue
            unexpected.append(
                f"posting ({term!r}, {doc_id}) changed without a matching issue")

    b_terms = baseline.lexicon.get("terms", {})
    f_terms = fixed.lexicon.get("terms", {})
    for term in sorted(set(b_terms) ^ set(f_terms)):
        if term in allowed_terms:
            continue
        # ingesting an orphan file may introduce brand-new terms
        if any(d in allowed_docs for d in f_post.get(term, [])):
            continue
        unexpected.append(f"lexicon entry added/removed for unflagged term {term!r}")
    for term in sorted(set(b_terms) & set(f_terms)):
        if b_terms[term] == f_terms[term]:
            continue
        if term in allowed_terms or term in posting_changed_terms:
            continue
        unexpected.append(f"lexicon entry changed for unflagged term {term!r}")

    if baseline.stats != fixed.stats and not allow_stats:
        unexpected.append(
            f"stats changed without a matching issue: "
            f"{baseline.stats} -> {fixed.stats}")
    return unexpected
