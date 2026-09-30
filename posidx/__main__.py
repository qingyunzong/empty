"""CLI for posidx.

Usage:
    python -m posidx ingest INDEX_DIR FILE.jsonl
    python -m posidx delete INDEX_DIR DOC_ID
    python -m posidx query  INDEX_DIR QUERY

Exit codes:
    0  success (query with no matches prints "[]" and still exits 0)
    2  one or more bad JSONL lines during ingest (bad lines are skipped)
    3  query syntax error
    4  index directory missing or corrupted
"""

from __future__ import annotations

import json
import os
import sys

from .core import CorruptIndexError, PositionalIndex, QuerySyntaxError

EXIT_OK = 0
EXIT_BAD_JSONL = 2
EXIT_QUERY_SYNTAX = 3
EXIT_CORRUPT_INDEX = 4

USAGE = __doc__


def _load_existing(directory: str) -> PositionalIndex:
    return PositionalIndex.load(directory)


def _load_for_ingest(directory: str) -> PositionalIndex:
    if not os.path.exists(os.path.join(directory, "manifest.json")):
        return PositionalIndex()
    return PositionalIndex.load(directory)


def cmd_ingest(index_dir: str, jsonl_path: str) -> int:
    try:
        index = _load_for_ingest(index_dir)
    except CorruptIndexError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CORRUPT_INDEX
    bad_lines = 0
    ingested = 0
    try:
        fh = open(jsonl_path, "r", encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot open {jsonl_path}: {exc}", file=sys.stderr)
        return EXIT_BAD_JSONL
    with fh:
        for lineno, line in enumerate(fh, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
                doc_id = record["id"]
                text = record["text"]
                if not isinstance(doc_id, str) or not isinstance(text, str):
                    raise ValueError("id and text must be strings")
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                print(f"warning: skipping bad line {lineno}: {exc}", file=sys.stderr)
                bad_lines += 1
                continue
            index.ingest(doc_id, text)
            ingested += 1
    index.save(index_dir)
    print(f"ingested {ingested} document(s), skipped {bad_lines} bad line(s)",
          file=sys.stderr)
    return EXIT_BAD_JSONL if bad_lines else EXIT_OK


def cmd_delete(index_dir: str, doc_id: str) -> int:
    try:
        index = _load_existing(index_dir)
    except CorruptIndexError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CORRUPT_INDEX
    removed = index.delete(doc_id)
    index.save(index_dir)
    print(f"deleted {doc_id!r}" if removed else f"no-op: {doc_id!r} not present",
          file=sys.stderr)
    return EXIT_OK


def cmd_query(index_dir: str, query: str) -> int:
    try:
        index = _load_existing(index_dir)
    except CorruptIndexError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CORRUPT_INDEX
    try:
        results = index.query(query)
    except QuerySyntaxError as exc:
        print(f"error: bad query: {exc}", file=sys.stderr)
        return EXIT_QUERY_SYNTAX
    print(json.dumps(results, ensure_ascii=False))
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help"):
        print(USAGE)
        return EXIT_OK if args else EXIT_QUERY_SYNTAX
    command, rest = args[0], args[1:]
    if command == "ingest" and len(rest) == 2:
        return cmd_ingest(rest[0], rest[1])
    if command == "delete" and len(rest) == 2:
        return cmd_delete(rest[0], rest[1])
    if command == "query" and len(rest) == 2:
        return cmd_query(rest[0], rest[1])
    print(USAGE, file=sys.stderr)
    return EXIT_QUERY_SYNTAX


if __name__ == "__main__":
    sys.exit(main())
