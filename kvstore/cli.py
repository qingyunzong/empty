"""JSON CLI for the WAL paged key-value store.

Reads a JSON script from stdin (or a file path given as argv[1]) and prints
a JSON document with per-action results and a recovery/action trace where
every step carries a human-readable reason.

Script format::

    {"config": {"num_pages": 16, "page_size": 256, "pool_capacity": 4},
     "dir": "/tmp/mydb",            # optional; a temp dir is used otherwise
     "actions": [
        {"op": "begin"},                             # -> {"tx": 1}
        {"op": "put", "tx": 1, "key": "a", "value": "1"},
        {"op": "get", "tx": 1, "key": "a"},
        {"op": "delete", "tx": 1, "key": "a"},
        {"op": "commit", "tx": 1},
        {"op": "abort", "tx": 1},
        {"op": "checkpoint"},
        {"op": "fault", "boundary": "clr_flush", "after": 2},
        {"op": "torn"},                              # next log append is torn
        {"op": "crash"},                             # abandon the engine
        {"op": "recover"},                           # reopen + ARIES recovery
        {"op": "dump"}
     ]}
"""

from __future__ import annotations

import json
import sys
import tempfile

from .adapter import FaultController, FaultyAdapter
from .engine import Engine
from .errors import CrashError


def run_script(script: dict) -> dict:
    cfg = script.get("config", {})
    dirpath = script.get("dir") or tempfile.mkdtemp(prefix="kvstore-")
    faults = FaultController()
    results: list[dict] = []
    eng: Engine | None = None

    def open_engine() -> Engine:
        return Engine.open(dirpath, adapter=FaultyAdapter(faults),
                           faults=faults, **cfg)

    eng = None

    def ensure() -> Engine:
        nonlocal eng
        if eng is None:
            eng = open_engine()
        return eng

    for i, act in enumerate(script.get("actions", [])):
        op = act.get("op")
        res: dict = {"i": i, "op": op}
        try:
            if op == "recover":
                eng = open_engine()
                res["trace"] = list(eng.trace)
                res["ok"] = True
                results.append(res)
                continue
            if op == "crash":
                eng = None
                res["ok"] = True
                results.append(res)
                continue
            if op == "fault":
                faults.arm(act["boundary"], act.get("after", 1))
                res["ok"] = True
                results.append(res)
                continue
            if op == "torn":
                faults.arm_torn_append()
                res["ok"] = True
                results.append(res)
                continue
            src = ensure()
            before = len(src.trace)
            if op == "begin":
                res["tx"] = src.begin()
            elif op == "put":
                src.put(act["tx"], act["key"], act["value"])
            elif op == "get":
                res["value"] = src.get(act["tx"], act["key"])
            elif op == "delete":
                src.delete(act["tx"], act["key"])
            elif op == "commit":
                src.commit(act["tx"])
            elif op == "abort":
                src.abort(act["tx"])
            elif op == "checkpoint":
                src.checkpoint()
            elif op == "dump":
                res["data"] = src.dump()
            else:
                raise ValueError(f"unknown op {op!r}")
            res["ok"] = True
            res["trace"] = src.trace[before:]
        except CrashError as exc:
            res["ok"] = False
            res["crash"] = str(exc)
            eng = None
        except Exception as exc:  # surfaced as JSON, not a traceback
            res["ok"] = False
            res["error"] = f"{type(exc).__name__}: {exc}"
        results.append(res)
    return {"ok": all(r.get("ok", False) or "crash" in r for r in results),
            "dir": dirpath, "results": results}


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if argv:
        with open(argv[0], "r", encoding="utf-8") as fh:
            script = json.load(fh)
    else:
        script = json.load(sys.stdin)
    out = run_script(script)
    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
