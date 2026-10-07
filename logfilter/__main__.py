"""JSON command-line interface.

Usage:
    python3.11 -m logfilter --store STORE add     < {"doc_id": "1", "text": "..."}
    python3.11 -m logfilter --store STORE add     < {"doc_id": "1", "terms": [...]}
    python3.11 -m logfilter --store STORE delete  < {"doc_id": "1"}
    python3.11 -m logfilter --store STORE search  < {"pattern": "ab*{~1}",
                                                     "limit": 10, "budget": 1000,
                                                     "cursor": null}
    python3.11 -m logfilter --store STORE stats   < {}

All input and output is JSON on stdin/stdout.  Exit codes: 0 ok,
2 invalid pattern / stale cursor / version mismatch, 1 other errors.
The store is only written by `add` and `delete`; a rejected pattern
therefore leaves the store byte-identical (atomic rejection).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

from .index import Index
from .pattern import PatternError
from .search import CursorError, NormalizationVersionError, search

_TOKEN_RE = re.compile(r"\w+", re.UNICODE)


def _load(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return Index.from_dict(json.load(fh))
    return Index()


def _save(path, index):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(index.to_dict(), fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _emit(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="logfilter", description=__doc__)
    parser.add_argument("--store", required=True, help="path to the JSON index store")
    parser.add_argument("command", choices=["add", "delete", "search", "stats"])
    args = parser.parse_args(argv)

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        _emit({"ok": False, "error": f"invalid JSON input: {exc}"})
        return 1

    index = _load(args.store)
    try:
        if args.command == "add":
            doc_id = payload["doc_id"]
            if "terms" in payload:
                terms = payload["terms"]
            else:
                terms = _TOKEN_RE.findall(payload.get("text", ""))
            index.add_document(doc_id, terms)
            _save(args.store, index)
            out = {
                "ok": True,
                "doc_id": str(doc_id),
                "num_docs": index.num_docs,
                "num_terms": index.num_terms,
            }
        elif args.command == "delete":
            removed = index.delete_document(payload["doc_id"])
            _save(args.store, index)
            out = {
                "ok": True,
                "removed": removed,
                "num_docs": index.num_docs,
                "num_terms": index.num_terms,
            }
        elif args.command == "stats":
            out = {
                "ok": True,
                "num_docs": index.num_docs,
                "num_terms": index.num_terms,
                "generation": index.generation,
                "normalization_version": index.normalization_version,
                "automaton_nodes": index.automaton.node_count,
            }
        else:  # search
            result = search(
                index,
                pattern=payload.get("pattern"),
                d=payload.get("d"),
                limit=payload.get("limit", 20),
                budget=payload.get("budget"),
                cursor=payload.get("cursor"),
            )
            out = {"ok": True, **result.to_dict()}
    except KeyError as exc:
        _emit({"ok": False, "error": f"missing field: {exc}"})
        return 1
    except PatternError as exc:
        _emit({"ok": False, "error": f"invalid pattern: {exc}"})
        return 2
    except (CursorError, NormalizationVersionError) as exc:
        _emit({"ok": False, "error": str(exc)})
        return 2
    _emit(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
