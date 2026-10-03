"""CLI: python -m asofjoin --facts F.jsonl --dim D.jsonl --tol 20000"""

from __future__ import annotations

import argparse
import json
import sys

from . import run_join


class BadLine(Exception):
    pass


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _check_record(rec, required, path, lineno):
    if not isinstance(rec, dict):
        raise BadLine(f"{path}:{lineno}: expected a JSON object")
    for field in required:
        if field not in rec:
            raise BadLine(f"{path}:{lineno}: missing field {field!r}")
    id_field = "fid" if "fid" in required else "did"
    if not isinstance(rec[id_field], str):
        raise BadLine(f"{path}:{lineno}: {id_field!r} must be a string")
    if not isinstance(rec["key"], str):
        raise BadLine(f"{path}:{lineno}: 'key' must be a string")
    if not _is_int(rec["ts"]):
        raise BadLine(f"{path}:{lineno}: 'ts' must be an integer")


def _read_jsonl(path, required):
    records = []
    try:
        fh = open(path, "r", encoding="utf-8")
    except OSError as exc:
        raise BadLine(f"cannot open {path}: {exc.strerror or exc}")
    with fh:
        for lineno, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as exc:
                raise BadLine(f"{path}:{lineno}: invalid JSON: {exc.msg}")
            _check_record(rec, required, path, lineno)
            records.append(rec)
    return records


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="asofjoin",
        description="As-of join a fact stream against a dimension stream.",
    )
    parser.add_argument("--facts", required=True, help="facts JSONL: {fid,key,ts}")
    parser.add_argument("--dim", required=True, help="dims JSONL: {did,key,ts,attr}")
    parser.add_argument("--tol", required=True, type=int,
                        help="max age (in ts units) of a matching dimension")
    args = parser.parse_args(argv)
    if args.tol < 0:
        parser.error("--tol must be >= 0")

    try:
        dims = _read_jsonl(args.dim, ("did", "key", "ts", "attr"))
        facts = _read_jsonl(args.facts, ("fid", "key", "ts"))
    except BadLine as exc:
        print(f"asofjoin: error: {exc}", file=sys.stderr)
        return 2

    for out in run_join(facts, dims, args.tol):
        print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
