"""Repair plan generation and application.

A repair plan is bound to the exact baseline it was created from via
``(baseline_version, baseline_fingerprint)``. Applying a plan re-validates
the baseline *before* touching anything; if the workspace has moved on
(different version or different content), the apply is refused and
nothing is written.

Plan operations express membership decisions (forget/register documents,
drop terms, resolve id collisions). After the decisions are applied, all
derived data (manifest hashes, postings, df/cf, statistics) is rebuilt
from the physical document files and the shared version is bumped.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from .tokenizer import tokenize
from .workspace import Workspace

# Issue codes that are repaired by recomputing derived data.
REFRESH_CODES = {
    "CF_MISMATCH",
    "DF_MISMATCH",
    "DOC_CONTENT_DRIFT",
    "DUPLICATE_POSTING",
    "MANIFEST_LENGTH_MISMATCH",
    "POSTINGS_DRIFT",
    "STATS_MISMATCH",
    "VERSION_SKEW",
}


class BaselineMismatchError(Exception):
    """The workspace no longer matches the plan's baseline."""


class RepairError(Exception):
    """The plan could not be executed."""


def build_plan(ws: Workspace, report) -> dict:
    """Derive a repair plan from an audit report."""
    forget = set()
    register = {}
    ops = []
    need_refresh = False
    for issue in report.sorted_issues():
        code, entity = issue.code, issue.entity
        if code in ("MISSING_DOC_FILE", "ORPHAN_DOC_REF"):
            forget.add(entity)
        elif code == "ORPHAN_DOC_FILE":
            register[Path(entity).stem] = entity
        elif code == "MISSING_LEXICON_ENTRY":
            ops.append({"op": "drop_index_term", "term_id": entity})
        elif code == "ORPHAN_LEXICON_ENTRY":
            ops.append({"op": "drop_term", "term": entity})
        elif code == "TERM_ID_COLLISION":
            ops.append({"op": "resolve_collision", "term_id": entity})
        elif code in REFRESH_CODES:
            need_refresh = True
    # A document that is both unregistered (orphan file) and still
    # referenced by the index is repaired by registering it, not by
    # forgetting it.
    forget -= set(register)
    doc_ops = [{"op": "forget_doc", "doc_id": doc_id} for doc_id in sorted(forget)]
    doc_ops += [
        {"op": "register_doc", "file": fname}
        for _, fname in sorted(register.items())
    ]
    ops = doc_ops + ops
    if need_refresh:
        ops.append({"op": "refresh_counts"})
    return {
        "baseline_version": report.version,
        "baseline_fingerprint": report.fingerprint,
        "issue_count": len(report.issues),
        "ops": ops,
    }


def _next_term_id(terms) -> str:
    seq = 0
    for entry in terms.values():
        tid = str(entry.get("term_id", ""))
        if tid.startswith("T") and tid[1:].isdigit():
            seq = max(seq, int(tid[1:]))
    return f"T{seq + 1:06d}"


def apply_plan(ws: Workspace, plan: dict) -> int:
    """Validate the baseline and apply *plan*. Returns the new version.

    Raises BaselineMismatchError (nothing written) if the workspace no
    longer matches the plan's baseline version or fingerprint.
    """
    current_version = ws.common_version()
    if plan.get("baseline_version") != current_version:
        raise BaselineMismatchError(
            f"baseline version mismatch: plan={plan.get('baseline_version')} "
            f"current={current_version}"
        )
    current_fingerprint = ws.fingerprint()
    if plan.get("baseline_fingerprint") != current_fingerprint:
        raise BaselineMismatchError(
            "baseline fingerprint mismatch: the workspace changed after "
            "the plan was created"
        )

    docstore = ws.load("docstore") or {"docs": {}}
    lexicon = ws.load("lexicon") or {"terms": {}}
    index = ws.load("index") or {"postings": {}}
    stats = ws.load("stats") or {}
    docs = docstore.setdefault("docs", {})
    terms = lexicon.setdefault("terms", {})
    postings = index.setdefault("postings", {})

    for op in plan.get("ops", []):
        name = op.get("op")
        if name == "forget_doc":
            docs.pop(op["doc_id"], None)
        elif name == "register_doc":
            doc_id = Path(op["file"]).stem
            docs[doc_id] = {
                "file": f"docs/{Path(op['file']).name}",
                "sha256": None,
                "num_tokens": None,
            }
        elif name == "drop_index_term":
            postings.pop(op["term_id"], None)
        elif name == "drop_term":
            entry = terms.pop(op["term"], None)
            if entry:
                postings.pop(entry.get("term_id"), None)
        elif name == "resolve_collision":
            owners = sorted(
                term for term, entry in terms.items()
                if entry.get("term_id") == op["term_id"]
            )
            for term in owners[1:]:
                terms[term]["term_id"] = _next_term_id(terms)
        elif name == "refresh_counts":
            pass  # handled by the rebuild below
        else:
            raise RepairError(f"unknown plan op: {name!r}")

    # Rebuild every derived structure from the physical document files.
    tokens_by_doc = {}
    for doc_id, meta in docs.items():
        path = ws.data_dir / meta["file"]
        try:
            raw = path.read_bytes()
            tokens = tokenize(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError) as exc:
            raise RepairError(
                f"cannot read {meta['file']} (doc {doc_id}): {exc}"
            ) from exc
        tokens_by_doc[doc_id] = tokens
        meta["sha256"] = hashlib.sha256(raw).hexdigest()
        meta["num_tokens"] = len(tokens)

    for tokens in tokens_by_doc.values():
        for term in set(tokens):
            if term not in terms:
                terms[term] = {"term_id": _next_term_id(terms), "df": 0, "cf": 0}

    df = {term: 0 for term in terms}
    cf = {term: 0 for term in terms}
    new_postings: dict = {}
    for doc_id, tokens in tokens_by_doc.items():
        for term in set(tokens):
            df[term] += 1
            new_postings.setdefault(terms[term]["term_id"], []).append(doc_id)
        for term in tokens:
            cf[term] += 1
    for term, entry in terms.items():
        entry["df"] = df[term]
        entry["cf"] = cf[term]
    index["postings"] = {
        term_id: sorted(doc_ids) for term_id, doc_ids in new_postings.items()
    }

    stats.clear()
    stats.update(
        {
            "num_docs": len(docs),
            "num_terms": len(terms),
            "total_tokens": sum(meta["num_tokens"] for meta in docs.values()),
        }
    )

    new_version = (current_version or 0) + 1
    for payload in (docstore, lexicon, index, stats):
        payload["version"] = new_version
    ws.save("docstore", docstore)
    ws.save("lexicon", lexicon)
    ws.save("index", index)
    ws.save("stats", stats)
    return new_version
