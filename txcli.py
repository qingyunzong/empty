"""CLI for the dependency-graph transactional store.

Reads commands from stdin, one per line:
  begin | set k v | depend a b | commit | rollback
  savepoint s | undo s | get k

`get` prints the value (or NULL) to stdout. On a command error the
message goes to stderr and the process exits with the error code
(3 cycle, 10 unknown savepoint, 11 no transaction, 2 usage).
"""

import sys

from txstore import ERR_CYCLE, ERR_NO_SAVEPOINT, ERR_NO_TX, Store, TxError

USAGE = "usage: begin|set k v|depend a b|commit|rollback|savepoint s|undo s|get k"


def run(store, lines, out):
    for line in lines:
        parts = line.split()
        if not parts:
            continue
        cmd, args = parts[0], parts[1:]
        if cmd == "begin" and not args:
            store.begin()
        elif cmd == "set" and len(args) == 2:
            store.set(args[0], args[1])
        elif cmd == "depend" and len(args) == 2:
            store.depend(args[0], args[1])
        elif cmd == "commit" and not args:
            store.commit()
        elif cmd == "rollback" and not args:
            store.rollback()
        elif cmd == "savepoint" and len(args) == 1:
            store.savepoint(args[0])
        elif cmd == "undo" and len(args) == 1:
            store.undo(args[0])
        elif cmd == "get" and len(args) == 1:
            value = store.get(args[0])
            out.write((value if value is not None else "NULL") + "\n")
        else:
            sys.stderr.write("bad command: %s\n%s\n" % (line.rstrip(), USAGE))
            return 2
    return 0


def main():
    store = Store()
    try:
        code = run(store, sys.stdin, sys.stdout)
    except TxError as exc:
        sys.stderr.write("error: %s\n" % exc)
        code = exc.code
    return code


if __name__ == "__main__":
    sys.exit(main())
