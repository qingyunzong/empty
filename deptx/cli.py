"""Command-line front end for the transactional dependency graph.

Reads one command per line from stdin (or a file given as argv[1]):

    begin            open a new (possibly nested) transaction layer
    set k v          set key k to value v in the current layer
    depend a b       add dependency edge a -> b (fails on cycles)
    commit           merge current layer into the parent layer / base
    rollback         discard the current layer entirely
    savepoint s      snapshot the current layer under name s
    undo s           restore the current layer to savepoint s
    get k            print the value of k in the current transaction view

A failing command is reported on stderr and processing continues; the
process exit code is the exit code of the first failing command
(3 = dependency cycle, 10 = unknown savepoint, 11 = no transaction,
2 = usage error), or 0 when every command succeeded.
"""

from __future__ import annotations

import sys
from typing import Iterable, TextIO

from .engine import Engine, TxError

EXIT_USAGE = 2


class UsageError(TxError):
    exit_code = EXIT_USAGE


def _arity(args: list[str], expected: int, cmd: str) -> None:
    if len(args) != expected:
        raise UsageError(f"{cmd} expects {expected} argument(s), got {len(args)}")


def run(lines: Iterable[str], out: TextIO, err: TextIO) -> int:
    engine = Engine()
    first_error = 0
    for lineno, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        cmd, args = parts[0], parts[1:]
        try:
            if cmd == "begin":
                _arity(args, 0, cmd)
                engine.begin()
            elif cmd == "set":
                if len(args) < 2:
                    raise UsageError("set expects a key and a value")
                engine.set(args[0], " ".join(args[1:]))
            elif cmd == "depend":
                _arity(args, 2, cmd)
                engine.depend(args[0], args[1])
            elif cmd == "commit":
                _arity(args, 0, cmd)
                engine.commit()
            elif cmd == "rollback":
                _arity(args, 0, cmd)
                engine.rollback()
            elif cmd == "savepoint":
                _arity(args, 1, cmd)
                engine.savepoint(args[0])
            elif cmd == "undo":
                _arity(args, 1, cmd)
                engine.undo(args[0])
            elif cmd == "get":
                _arity(args, 1, cmd)
                value = engine.get(args[0])
                print("None" if value is None else value, file=out)
            else:
                raise UsageError(f"unknown command: {cmd}")
        except TxError as exc:
            print(f"line {lineno}: error: {exc}", file=err)
            if not first_error:
                first_error = exc.exit_code
    return first_error


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) > 1:
        print("usage: python -m deptx [script-file]", file=sys.stderr)
        return EXIT_USAGE
    if argv:
        with open(argv[0], "r", encoding="utf-8") as handle:
            return run(handle, sys.stdout, sys.stderr)
    return run(sys.stdin, sys.stdout, sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
