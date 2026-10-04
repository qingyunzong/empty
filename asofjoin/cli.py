"""Command line interface: python -m asofjoin --facts F.jsonl --dim D.jsonl --tol 20000"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Iterable

from .core import Dim, Fact, join


class InputError(Exception):
    """Raised for malformed input lines (exit code 2)."""


def _nonnegative_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid int value: {text!r}")
    if value < 0:
        raise argparse.ArgumentTypeError("tol must be >= 0")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="asofjoin",
        description="As-of join of fact and dimension JSONL streams.",
    )
    parser.add_argument("--facts", required=True, help="facts JSONL: {fid,key,ts}")
    parser.add_argument("--dim", required=True, help="dimensions JSONL: {did,key,ts,attr}")
    parser.add_argument("--tol", required=True, type=_nonnegative_int,
                        help="lookback tolerance (same unit as ts), must be >= 0")
    return parser


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _load(path: str, kind: str) -> Iterable:
    def fail(lineno: int, msg: str) -> InputError:
        return InputError(f"{path}:{lineno}: {msg}")

    with open(path, "r", encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, 1):
            line = raw.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise fail(lineno, f"invalid JSON: {exc.msg}")
            if not isinstance(obj, dict):
                raise fail(lineno, "expected a JSON object")
            if kind == "fact":
                fid, key, ts = obj.get("fid"), obj.get("key"), obj.get("ts")
                if not isinstance(fid, str):
                    raise fail(lineno, "fact requires string field 'fid'")
                if not isinstance(key, str):
                    raise fail(lineno, "fact requires string field 'key'")
                if not _is_int(ts):
                    raise fail(lineno, "fact requires integer field 'ts'")
                yield Fact(fid=fid, key=key, ts=ts)
            else:
                did, key, ts = obj.get("did"), obj.get("key"), obj.get("ts")
                if not isinstance(did, str):
                    raise fail(lineno, "dim requires string field 'did'")
                if not isinstance(key, str):
                    raise fail(lineno, "dim requires string field 'key'")
                if not _is_int(ts):
                    raise fail(lineno, "dim requires integer field 'ts'")
                if "attr" not in obj:
                    raise fail(lineno, "dim requires field 'attr'")
                yield Dim(did=did, key=key, ts=ts, attr=obj["attr"])


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        dims = list(_load(args.dim, "dim"))
        facts = list(_load(args.facts, "fact"))
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    out = sys.stdout
    for result in join(facts, dims, args.tol):
        out.write(json.dumps(result.to_dict(), ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
