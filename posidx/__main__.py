"""Command line interface: ``python -m posidx <command> ...``.

Commands:
    ingest INDEX_DIR FILE.jsonl   Ingest JSONL lines {"id": str, "text": str}.
    delete INDEX_DIR ID           Delete a document id (no-op if absent).
    query  INDEX_DIR 'QUERY'      Run a boolean/phrase query, print JSON ids.

Exit codes:
    0  success (a query with no results prints ``[]`` and still exits 0)
    2  one or more JSONL lines were malformed (bad lines are skipped)
    3  query syntax error
    4  index directory is corrupt or unreadable
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .index import MANIFEST_NAME, IndexCorruptError, PositionalIndex
from .query import QuerySyntaxError, parse_query, evaluate

EXIT_OK = 0
EXIT_BAD_JSONL = 2
EXIT_BAD_QUERY = 3
EXIT_CORRUPT_INDEX = 4


def _err(message: str) -> None:
    print(f"posidx: {message}", file=sys.stderr)


def _load_existing(directory: str) -> PositionalIndex:
    try:
        return PositionalIndex.load(directory)
    except IndexCorruptError as exc:
        _err(str(exc))
        sys.exit(EXIT_CORRUPT_INDEX)


def _load_or_new(directory: str) -> PositionalIndex:
    """Load the index in *directory*, or start empty if none exists yet."""
    if os.path.exists(os.path.join(directory, MANIFEST_NAME)):
        return _load_existing(directory)
    if os.path.isdir(directory) and os.listdir(directory):
        _err(f"index directory {directory!r} exists but has no manifest")
        sys.exit(EXIT_CORRUPT_INDEX)
    return PositionalIndex()


def cmd_ingest(args: argparse.Namespace) -> int:
    index = _load_or_new(args.index_dir)
    bad_lines = 0
    try:
        fh = open(args.jsonl, "r", encoding="utf-8")
    except OSError as exc:
        _err(f"cannot open {args.jsonl}: {exc}")
        return EXIT_BAD_JSONL
    with fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if (
                    not isinstance(obj, dict)
                    or not isinstance(obj.get("id"), str)
                    or not isinstance(obj.get("text"), str)
                ):
                    raise ValueError("expected {\"id\": str, \"text\": str}")
            except ValueError as exc:
                _err(f"{args.jsonl}:{lineno}: skipping bad line ({exc})")
                bad_lines += 1
                continue
            index.ingest(obj["id"], obj["text"])
    index.save(args.index_dir)
    print(
        f"ingested into {args.index_dir}: {len(index)} document(s)"
        + (f", {bad_lines} bad line(s) skipped" if bad_lines else "")
    )
    return EXIT_BAD_JSONL if bad_lines else EXIT_OK


def cmd_delete(args: argparse.Namespace) -> int:
    index = _load_or_new(args.index_dir)
    removed = index.delete(args.doc_id)
    index.save(args.index_dir)
    print(f"deleted {args.doc_id!r}" if removed else f"no such id {args.doc_id!r} (no-op)")
    return EXIT_OK


def cmd_query(args: argparse.Namespace) -> int:
    if os.path.isdir(args.index_dir):
        index = _load_existing(args.index_dir)
    elif os.path.exists(args.index_dir):
        _err(f"index path {args.index_dir!r} is not a directory")
        return EXIT_CORRUPT_INDEX
    else:
        index = PositionalIndex()
    try:
        ast = parse_query(args.query)
    except QuerySyntaxError as exc:
        _err(f"query syntax error: {exc}")
        return EXIT_BAD_QUERY
    hits = evaluate(ast, index)
    print(json.dumps(sorted(hits), ensure_ascii=False))
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="posidx", description="Positional inverted index CLI"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_ingest = sub.add_parser("ingest", help="ingest a JSONL file")
    p_ingest.add_argument("index_dir")
    p_ingest.add_argument("jsonl")
    p_ingest.set_defaults(func=cmd_ingest)

    p_delete = sub.add_parser("delete", help="delete a document id")
    p_delete.add_argument("index_dir")
    p_delete.add_argument("doc_id")
    p_delete.set_defaults(func=cmd_delete)

    p_query = sub.add_parser("query", help="run a query")
    p_query.add_argument("index_dir")
    p_query.add_argument("query")
    p_query.set_defaults(func=cmd_query)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
