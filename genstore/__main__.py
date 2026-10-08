"""genstore command line interface.

Usage:
    python -m genstore [--file PATH] txn set KEY VALUE
    python -m genstore [--file PATH] txn del KEY
    python -m genstore [--file PATH] commit
    python -m genstore [--file PATH] rollback
    python -m genstore [--file PATH] recover
    python -m genstore [--file PATH] get KEY
    python -m genstore [--file PATH] status
    python -m genstore [--file PATH] dump

Environment:
    GENSTORE_PATH   default store file (when --file is not given)
    GENSTORE_FAULT  arm a one-shot crash fault: A, B, C or D
"""

import argparse
import os
import sys

from . import store as store_mod
from .store import GenStore, OP_DEL, OP_SET, StoreError


def main(argv=None):
    parser = argparse.ArgumentParser(prog="genstore")
    parser.add_argument("--file", default=None, help="store file path")
    sub = parser.add_subparsers(dest="command", required=True)

    p_txn = sub.add_parser("txn", help="append a redo record to the tail")
    p_txn.add_argument("op", choices=["set", "del"])
    p_txn.add_argument("key")
    p_txn.add_argument("value", nargs="?")

    sub.add_parser("commit", help="commit the pending transaction")
    sub.add_parser("rollback", help="discard the uncommitted tail")
    sub.add_parser("recover", help="run crash recovery")

    p_get = sub.add_parser("get", help="look up a key")
    p_get.add_argument("key")

    sub.add_parser("status", help="print the current generation G")
    sub.add_parser("dump", help="print all key=value pairs")

    args = parser.parse_args(argv)
    path = args.file or os.environ.get("GENSTORE_PATH", "genstore.db")

    fault = os.environ.get("GENSTORE_FAULT", "").strip().upper()
    if fault:
        store_mod.set_fault(fault)
        store_mod.set_crash_mode("exit")  # hard power-loss: die mid-write

    try:
        with GenStore(path) as store:
            if args.command == "txn":
                key = args.key.encode()
                if args.op == "set":
                    if args.value is None:
                        parser.error("txn set requires a value")
                    store.txn_op(OP_SET, key, args.value.encode())
                else:
                    store.txn_op(OP_DEL, key)
                print("txn recorded")
            elif args.command == "commit":
                if store.commit():
                    print(f"committed G={store.G}")
                else:
                    print("nothing to commit")
            elif args.command == "rollback":
                if store.rollback():
                    print("rolled back")
                else:
                    print("nothing to rollback")
            elif args.command == "recover":
                if store.recovered_empty:
                    print("EmptyStore: root corrupt and no valid backup "
                          "header; reinitialized empty store")
                print(f"recovered G={store.G}")
            elif args.command == "get":
                value = store.get(args.key.encode())
                if value is None:
                    print("not found", file=sys.stderr)
                    return 1
                print(value.decode(errors="replace"))
            elif args.command == "status":
                print(f"G={store.G}")
            elif args.command == "dump":
                for key, value in sorted(store.dump().items()):
                    print(f"{key.decode(errors='replace')}="
                          f"{value.decode(errors='replace')}")
    except StoreError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
