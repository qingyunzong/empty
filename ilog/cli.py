"""Command line interface for ilog.

Usage:
    python -m ilog.cli [--file PATH] OP [OP ...]

Operations are applied left to right. Mutations (add/remove/compact) only
affect the in-memory tmp state; nothing is persisted unless ``commit``
appears in the operation sequence.

    add LO HI     add the half-open interval [LO, HI)
    remove LO HI  remove the half-open interval [LO, HI)
    compact       normalize (merge adjacent/overlapping intervals)
    commit        persist the current state via the crash-safe commit flow
    show          print the current in-memory state as JSON

Exit status: 0 on success, 2 on any IlogError (code=IO or BAD_INTERVAL).
"""

from __future__ import annotations

import json
import sys

from .core import IlogError, IntervalStore

USAGE = __doc__


def _state(store: IntervalStore) -> dict:
    return {"intervals": [list(iv) for iv in store.intervals]}


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    path = "intervals.json"
    if argv[:1] == ["--file"]:
        if len(argv) < 2:
            print("error code=IO: --file requires a path", file=sys.stderr)
            return 2
        path = argv[1]
        del argv[:2]

    try:
        store = IntervalStore.open(path)
        if store.recovered != "clean":
            print(f"recovered={store.recovered}", file=sys.stderr)

        idx = 0
        while idx < len(argv):
            op = argv[idx]
            if op in ("add", "remove"):
                try:
                    lo = int(argv[idx + 1])
                    hi = int(argv[idx + 2])
                except (IndexError, ValueError):
                    raise IlogError(
                        "BAD_INTERVAL", f"{op} requires two integer bounds"
                    )
                getattr(store, op)(lo, hi)
                idx += 3
            elif op == "compact":
                store.compact()
                idx += 1
            elif op == "commit":
                store.commit()
                print(json.dumps({"committed": True, **_state(store)}))
                idx += 1
            elif op == "show":
                print(json.dumps({"recovered": store.recovered, **_state(store)}))
                idx += 1
            else:
                raise IlogError("BAD_INTERVAL", f"unknown operation: {op!r}")
        return 0
    except IlogError as exc:
        print(f"error code={exc.code}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
