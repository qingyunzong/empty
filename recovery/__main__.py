"""Command-line interface.

Usage:
    python -m recovery <datadir>            read commands from stdin
    python -m recovery <datadir> script.txt read commands from a file

Commands (one per line, '#' starts a comment):
    put <txn> <key> <value>   write value under transaction txn
    commit <txn>              commit transaction txn
    abort <txn>               roll back transaction txn
    checkpoint                flush dirty pages, log dirty set + txn table
    crash                     discard all in-memory state (disk survives)
    recover                   redo from last checkpoint, then undo losers
    dump                      print every slot as 'key=value'
"""

import sys

from .engine import Engine


def run(engine, lines, out):
    for lineno, raw in enumerate(lines, 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        cmd, args = parts[0], parts[1:]
        try:
            if cmd == "put":
                engine.put(int(args[0]), int(args[1]), int(args[2]))
            elif cmd == "commit":
                engine.commit(int(args[0]))
            elif cmd == "abort":
                engine.abort(int(args[0]))
            elif cmd == "checkpoint":
                engine.checkpoint()
            elif cmd == "crash":
                engine.crash()
            elif cmd == "recover":
                engine.recover()
            elif cmd == "dump":
                for key, value in engine.dump().items():
                    print(f"{key}={value}", file=out)
            else:
                raise ValueError(f"unknown command {cmd!r}")
        except (ValueError, IndexError) as exc:
            raise SystemExit(f"line {lineno}: {line!r}: {exc}")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        raise SystemExit(__doc__)
    engine = Engine(argv[0])
    try:
        if len(argv) > 1:
            with open(argv[1], "r", encoding="utf-8") as fh:
                run(engine, fh, sys.stdout)
        else:
            run(engine, sys.stdin, sys.stdout)
    finally:
        engine.close()


if __name__ == "__main__":
    main()
