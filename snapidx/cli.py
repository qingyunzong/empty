"""snapidx command line interface.

Usage:
    python -m snapidx [--log PATH] [SCRIPT]

Commands are read line by line from SCRIPT (or stdin). Blank lines and
lines starting with '#' are ignored. Commands:

    begin                        open a (nested) transaction
    add ID TERM...               add/overwrite a document
    del ID                       delete a document (no-op if missing)
    commit                       commit innermost transaction
    rollback                     discard innermost transaction layer
    search TERM [--snapshot S]   list matching ids (S = commit sequence no.)
    seq                          print current commit sequence number

Exit codes: 0 ok; 2 usage error; 3 state error (unknown snapshot,
rollback/commit/add/del without an active transaction).
"""

from __future__ import annotations

import argparse
import sys

from .core import SnapIdx, SnapIdxError


def run_line(idx: SnapIdx, tokens: list[str], out) -> None:
    cmd, args = tokens[0], tokens[1:]
    if cmd == "begin":
        idx.begin()
        print(f"ok begin depth={idx.txn_depth}", file=out)
    elif cmd == "add":
        if len(args) < 1:
            raise SystemExit("usage: add ID [TERM...]")
        idx.add(args[0], args[1:])
        print(f"ok add {args[0]}", file=out)
    elif cmd == "del":
        if len(args) != 1:
            raise SystemExit("usage: del ID")
        idx.delete(args[0])
        print(f"ok del {args[0]}", file=out)
    elif cmd == "commit":
        if args:
            raise SystemExit("usage: commit")
        depth_before = idx.txn_depth
        seq = idx.commit()
        if depth_before > 1:
            print(f"ok commit nested depth={idx.txn_depth}", file=out)
        elif seq is None:
            print(f"ok commit empty seq={idx.seq}", file=out)
        else:
            print(f"ok commit seq={seq}", file=out)
    elif cmd == "rollback":
        if args:
            raise SystemExit("usage: rollback")
        idx.rollback()
        print(f"ok rollback depth={idx.txn_depth}", file=out)
    elif cmd == "search":
        snapshot = None
        terms = list(args)
        if "--snapshot" in terms:
            i = terms.index("--snapshot")
            if i + 1 >= len(terms):
                raise SystemExit("usage: search TERM [--snapshot S]")
            try:
                snapshot = int(terms[i + 1])
            except ValueError:
                raise SystemExit(f"invalid snapshot id: {terms[i + 1]!r}")
            del terms[i:i + 2]
        if len(terms) != 1:
            raise SystemExit("usage: search TERM [--snapshot S]")
        ids = idx.search(terms[0], snapshot=snapshot)
        print(" ".join(ids) if ids else "(none)", file=out)
    elif cmd == "seq":
        print(f"seq={idx.seq}", file=out)
    else:
        raise SystemExit(f"unknown command: {cmd!r}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="snapidx", description=__doc__)
    parser.add_argument("--log", metavar="PATH", default=None,
                        help="commit log file for persistence/recovery")
    parser.add_argument("script", nargs="?", default=None,
                        help="command script (default: stdin)")
    ns = parser.parse_args(argv)

    if ns.script is None or ns.script == "-":
        lines = sys.stdin
    else:
        lines = open(ns.script, "r", encoding="utf-8")

    idx = SnapIdx(log_path=ns.log)
    try:
        for lineno, raw in enumerate(lines, 1):
            stripped = raw.strip()
            if not stripped or stripped.startswith("#"):
                continue
            tokens = stripped.split()
            try:
                run_line(idx, tokens, sys.stdout)
            except SnapIdxError as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 3
            except SystemExit as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 2
    finally:
        idx.close()
        if lines is not sys.stdin:
            lines.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
