"""JSON-lines CLI: reads one command object per line on stdin, writes one
JSON response per line on stdout.

Commands:
  {"cmd": "batch", "batch": {...batch fields...}}   apply a batch atomically
  {"cmd": "batch", ...batch fields directly...}     (shorthand)
  {"cmd": "view"}                                   current group view
  {"cmd": "median", "group": "g"}                   median of one group
  {"cmd": "rank", "group": "g", "value": 3}         rank of value in group
  {"cmd": "outputs"}                                committed output cursor
  {"cmd": "checkpoint"}                             write a checkpoint
  {"cmd": "recover"}                                rebuild from log + checkpoint

Batch fields: left_insert [{id,cid,value}], left_retract [id],
left_replace [{id,cid,value}], right_insert/right_retract
[{cid,group,count}], migrate [{cid,from,to,count}]. NULL (null) cids never
join; null values are excluded from SUM/median but counted in COUNT(*).
"""

from __future__ import annotations

import argparse
import json
import sys

from .engine import BatchError, Engine
from .storage import Storage

BATCH_KEYS = ("left_insert", "left_retract", "left_replace",
              "right_insert", "right_retract", "migrate")


def run(engine, storage, line):
    msg = json.loads(line)
    cmd = msg.get("cmd")
    if cmd == "batch" or any(k in msg for k in BATCH_KEYS):
        batch = msg.get("batch", {k: msg[k] for k in BATCH_KEYS if k in msg})
        record = engine.apply_batch(batch)
        return {"ok": True, "applied": record, "view": engine.view()}
    if cmd == "view":
        return {"ok": True, "view": engine.view()}
    if cmd == "median":
        return {"ok": True, "group": msg.get("group"), "median": engine.median(msg.get("group"))}
    if cmd == "rank":
        return {"ok": True, "group": msg.get("group"),
                "rank": engine.rank(msg.get("group"), msg.get("value"))}
    if cmd == "outputs":
        return {"ok": True, "outputs": engine.outputs}
    if cmd == "checkpoint":
        if storage is None:
            return {"ok": False, "error": "no storage directory configured"}
        storage.checkpoint(engine)
        return {"ok": True, "batch_id": engine.batch_id}
    if cmd == "recover":
        if storage is None:
            return {"ok": False, "error": "no storage directory configured"}
        replayed = Storage.recover(engine, storage.dir)
        return {"ok": True, "replayed": replayed, "view": engine.view()}
    return {"ok": False, "error": f"unknown command: {cmd!r}"}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="mvview")
    parser.add_argument("--dir", help="storage directory for WAL + checkpoints")
    args = parser.parse_args(argv)

    storage = Storage(args.dir) if args.dir else None
    engine = Engine(storage)
    if storage is not None:
        Storage.recover(engine, storage.dir)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            resp = run(engine, storage, line)
        except BatchError as exc:
            resp = {"ok": False, "error": str(exc)}
        except (KeyError, TypeError, ValueError) as exc:
            resp = {"ok": False, "error": f"bad request: {exc}"}
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    if storage is not None:
        storage.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
