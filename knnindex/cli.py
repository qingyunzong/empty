"""JSON command-line interface for the exact KNN index.

Every command reads/writes a JSON database file and prints a JSON object to
stdout.  Coordinates accept integers, decimals or fractions ("3/4"); all
arithmetic is exact rational.
"""

from __future__ import annotations

import argparse
import json
import sys

from .filters import evaluate
from .geometry import dist2, to_point
from .index import KNNIndex, Cursor
from .query import StaleCursorError
from .tree import iter_entries
from .verify import verify_result


def _parse_coords(text: str):
    return [c.strip() for c in text.split(",") if c.strip() != ""]


def _parse_labels(text):
    if not text:
        return []
    return [t.strip() for t in text.split(",") if t.strip()]


def _parse_filter(text):
    return json.loads(text) if text else None


def _load(args) -> KNNIndex:
    return KNNIndex.load(args.db)


def _emit(obj) -> int:
    json.dump(obj, sys.stdout, indent=1)
    sys.stdout.write("\n")
    return 0


def cmd_create(args) -> int:
    index = KNNIndex(args.dims, leaf_capacity=args.capacity)
    index.save(args.db)
    return _emit({"ok": True, "dims": args.dims, "db": args.db})


def cmd_insert(args) -> int:
    index = _load(args)
    version = index.insert(args.id, _parse_coords(args.coords), _parse_labels(args.labels))
    index.save(args.db)
    return _emit({"ok": True, "version": version, "size": len(index)})


def cmd_delete(args) -> int:
    index = _load(args)
    removed = index.delete(args.id)
    index.save(args.db)
    return _emit({"ok": removed, "version": index.version, "size": len(index)})


def cmd_replace(args) -> int:
    index = _load(args)
    version = index.replace(args.id, _parse_coords(args.coords), _parse_labels(args.labels))
    index.save(args.db)
    return _emit({"ok": True, "version": version, "size": len(index)})


def cmd_query(args) -> int:
    index = _load(args)
    result = index.query(
        _parse_coords(args.coords),
        args.k,
        _parse_filter(args.filter),
        budget=args.budget,
        version=args.version,
    )
    out = result.to_json()
    out["k"] = args.k
    if result.status == "unknown":
        cursor = index.cursor_for(result, _parse_coords(args.coords), args.k,
                                  _parse_filter(args.filter))
        out["cursor"] = cursor.to_json()
    return _emit(out)


def cmd_resume(args) -> int:
    index = _load(args)
    with open(args.cursor, "r", encoding="utf-8") as fh:
        cursor = Cursor.from_json(json.load(fh))
    try:
        result = index.resume(cursor, budget=args.budget)
    except StaleCursorError as exc:
        return _emit({"ok": False, "error": str(exc)})
    out = result.to_json()
    out["k"] = cursor.k
    if result.status == "unknown":
        out["cursor"] = index.cursor_for(
            result, [str(c) for c in cursor.query], cursor.k, cursor.filter_expr
        ).to_json()
    return _emit(out)


def cmd_snapshot(args) -> int:
    index = _load(args)
    version = index.snapshot()
    index.save(args.db)
    return _emit({"ok": True, "snapshot": version})


def cmd_verify(args) -> int:
    index = _load(args)
    coords = _parse_coords(args.coords)
    filter_expr = _parse_filter(args.filter)
    result = index.query(coords, args.k, filter_expr, budget=args.budget,
                         version=args.version)
    entries = list(iter_entries(index._root_at(args.version)))
    problems = verify_result(result, entries, to_point(coords), args.k, filter_expr)
    return _emit({
        "ok": not problems,
        "problems": problems,
        "result": result.to_json(),
    })


def cmd_stats(args) -> int:
    index = _load(args)
    root = index._root
    return _emit({
        "version": index.version,
        "size": len(index),
        "dims": index.dims,
        "snapshots": sorted(index._snapshots),
        "root_count": 0 if root is None else root.count,
    })


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="knnindex", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("create")
    p.add_argument("--db", required=True)
    p.add_argument("--dims", type=int, required=True)
    p.add_argument("--capacity", type=int, default=8)
    p.set_defaults(fn=cmd_create)

    for name, fn in (("insert", cmd_insert), ("replace", cmd_replace)):
        p = sub.add_parser(name)
        p.add_argument("--db", required=True)
        p.add_argument("--id", required=True)
        p.add_argument("--coords", required=True)
        p.add_argument("--labels", default="")
        p.set_defaults(fn=fn)

    p = sub.add_parser("delete")
    p.add_argument("--db", required=True)
    p.add_argument("--id", required=True)
    p.set_defaults(fn=cmd_delete)

    for name, fn in (("query", cmd_query), ("verify", cmd_verify)):
        p = sub.add_parser(name)
        p.add_argument("--db", required=True)
        p.add_argument("--coords", required=True)
        p.add_argument("--k", type=int, required=True)
        p.add_argument("--filter", default=None)
        p.add_argument("--budget", type=int, default=None)
        p.add_argument("--version", type=int, default=None)
        p.set_defaults(fn=fn)

    p = sub.add_parser("resume")
    p.add_argument("--db", required=True)
    p.add_argument("--cursor", required=True, help="path to cursor JSON file")
    p.add_argument("--budget", type=int, default=None)
    p.set_defaults(fn=cmd_resume)

    p = sub.add_parser("snapshot")
    p.add_argument("--db", required=True)
    p.set_defaults(fn=cmd_snapshot)

    p = sub.add_parser("stats")
    p.add_argument("--db", required=True)
    p.set_defaults(fn=cmd_stats)

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except (KeyError, ValueError, FileNotFoundError) as exc:
        return _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    raise SystemExit(main())
