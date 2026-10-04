"""JSON command-line interface.

Usage:
    python -m logfilter INDEX add DOC_ID TEXT...
    python -m logfilter INDEX delete DOC_ID
    python -m logfilter INDEX search PATTERN [--limit N] [--budget N] [--cursor JSON]
    python -m logfilter INDEX stats

Global option: --rules VERSION (normalization version for a new index).
All output is a single JSON object on stdout.  Exit code 0 on success,
2 on any error (the error is reported as JSON and the index file is left
untouched -- failures are atomic).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .index import Index, VersionMismatchError
from .normalize import DEFAULT_VERSION, NormalizationRules
from .pattern import PatternError, parse_pattern
from .search import CursorError, search


def _emit(payload, code=0):
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return code


def _error(exc):
    return _emit(
        {"error": {"type": type(exc).__name__, "message": str(exc)}}, code=2
    )


def _load_or_create(path, rules):
    if os.path.exists(path):
        return Index.load(path, rules)
    return Index(rules)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="logfilter")
    parser.add_argument("index", help="path to the index JSON file")
    parser.add_argument(
        "--rules",
        default=DEFAULT_VERSION,
        help="normalization version for a newly created index",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="add or replace a document")
    p_add.add_argument("doc_id")
    p_add.add_argument("text", nargs="+")

    p_del = sub.add_parser("delete", help="delete a document")
    p_del.add_argument("doc_id")

    p_search = sub.add_parser("search", help="search with a pattern")
    p_search.add_argument("pattern")
    p_search.add_argument("--limit", type=int, default=None)
    p_search.add_argument("--budget", type=int, default=None)
    p_search.add_argument("--cursor", default=None, help="cursor JSON from a previous page")

    sub.add_parser("stats", help="show index statistics")

    args = parser.parse_args(argv)
    rules = NormalizationRules(args.rules)

    try:
        if args.command == "add":
            index = _load_or_create(args.index, rules)
            terms = index.add_document(args.doc_id, " ".join(args.text))
            index.save(args.index)
            return _emit(
                {"ok": True, "doc": args.doc_id, "terms": len(terms),
                 "stats": index.stats()}
            )
        if args.command == "delete":
            index = _load_or_create(args.index, rules)
            deleted = index.delete_document(args.doc_id)
            index.save(args.index)
            return _emit(
                {"ok": True, "deleted": deleted, "stats": index.stats()}
            )
        if args.command == "stats":
            index = Index.load(args.index)
            return _emit({"ok": True, "stats": index.stats()})
        if args.command == "search":
            # Compile the pattern BEFORE touching the index so malformed
            # patterns are rejected atomically.
            pattern = parse_pattern(args.pattern, rules)
            cursor = json.loads(args.cursor) if args.cursor else None
            index = Index.load(args.index)
            result = search(
                index, pattern, limit=args.limit, budget=args.budget, cursor=cursor
            )
            documents = sorted(
                {doc for hit in result["results"] for doc in hit["docs"]}
            )
            return _emit(
                {
                    "ok": True,
                    "complete": result["complete"],
                    "results": result["results"],
                    "documents": documents,
                    "cursor": result["cursor"],
                    "stats": result["stats"],
                }
            )
    except (PatternError, CursorError, VersionMismatchError, ValueError, OSError) as exc:
        return _error(exc)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
