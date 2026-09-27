"""Command line interface.

Usage:
    python -m recovery --dir DBDIR "put t1 k1 v1" "commit t1" checkpoint \
        crash recover dump
    python -m recovery --dir DBDIR --script ops.txt
    cat ops.txt | python -m recovery --dir DBDIR

Commands:
    put TXN KEY VALUE   write KEY=VALUE in TXN (implicitly begins TXN)
    commit TXN          commit TXN
    checkpoint          write a checkpoint record and flush dirty pages
    crash               discard all in-memory state (only disk survives)
    recover             run analysis/redo/undo recovery
    dump                print the current database state as sorted k=v lines
"""

import argparse
import sys

from .engine import Engine


def run_command(engine, tokens):
    cmd, args = tokens[0], tokens[1:]
    if cmd == "put":
        txn, key, value = args
        engine.put(txn, key, value)
    elif cmd == "commit":
        engine.commit(args[0])
    elif cmd == "checkpoint":
        engine.checkpoint()
    elif cmd == "crash":
        engine.crash()
    elif cmd == "recover":
        stats = engine.recover()
        print("recovered: redone=%(redone)d clrs=%(clrs)d losers=%(losers)s" % stats)
    elif cmd == "dump":
        state = engine.dump()
        for key in sorted(state):
            print("%s=%s" % (key, state[key]))
    else:
        raise ValueError("unknown command: %r" % cmd)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="recovery")
    parser.add_argument("--dir", required=True, help="database directory")
    parser.add_argument("--script", help="file with one command per line")
    parser.add_argument("commands", nargs="*",
                        help="commands, e.g. \"put t1 a 1\" \"commit t1\"")
    ns = parser.parse_args(argv)

    commands = list(ns.commands)
    if ns.script:
        with open(ns.script, "r", encoding="utf-8") as f:
            commands.extend(
                line.strip() for line in f
                if line.strip() and not line.startswith("#"))
    if not commands and not sys.stdin.isatty():
        commands = [line.strip() for line in sys.stdin if line.strip()]

    engine = Engine(ns.dir)
    try:
        for line in commands:
            run_command(engine, line.split())
    finally:
        engine.close()
    return 0
