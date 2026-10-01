"""JSON-lines CLI for the replication group simulator.

Reads one JSON command per line from stdin, writes one JSON result per
line to stdout. If any command fails, the process exits with status 6.

Commands:
  {"cmd": "propose", "value": V, "epoch": E?}  -> {"ok": true, "seq": N, "epoch": E}
  {"cmd": "ack", "node": NAME, "seq": N}       -> {"ok": true, "committed": bool}
  {"cmd": "begin", "old": [N...], "new": [N...]} -> {"ok": true, "epoch": E, "phase": "joint"}
  {"cmd": "commit"}                            -> {"ok": true, "epoch": E, "members": [...]}
  {"cmd": "abort"}                             -> {"ok": true, "epoch": E, "members": [...]}
  {"cmd": "write", "value": V}                 -> {"ok": true, "seq": N, "committed": true}
  {"cmd": "read"}                              -> {"ok": true, "value": V, "epoch": E, ...}

Environment:
  CLUSTER_DATA_DIR   state directory (default: ./cluster_data)
  CLUSTER_NODES      comma-separated initial members (default: n1,n2,n3)
  SIM_CRASH_BEFORE_CONFIG_FSYNC  if set, crash (exit 2) right before the
                     fsync of any configuration record
"""

from __future__ import annotations

import json
import os
import sys

from .core import Cluster, ReplError

EXIT_ERROR = 6


def handle(cluster: Cluster, req: dict) -> dict:
    cmd = req.get("cmd")
    if cmd == "propose":
        seq, epoch = cluster.propose(req.get("value"), req.get("epoch"))
        return {"ok": True, "seq": seq, "epoch": epoch}
    if cmd == "ack":
        committed = cluster.ack(req["node"], req["seq"])
        return {"ok": True, "seq": req["seq"], "committed": committed}
    if cmd == "begin":
        epoch = cluster.begin_change(req["old"], req["new"])
        return {"ok": True, "epoch": epoch, "phase": "joint"}
    if cmd == "commit":
        epoch = cluster.commit_change()
        return {"ok": True, "epoch": epoch, "members": sorted(cluster.members)}
    if cmd == "abort":
        epoch = cluster.abort_change()
        return {"ok": True, "epoch": epoch, "members": sorted(cluster.members)}
    if cmd == "write":
        seq = cluster.write(req.get("value"))
        return {"ok": True, "seq": seq, "committed": True}
    if cmd == "read":
        return {"ok": True, **cluster.read()}
    raise ReplError(f"unknown command: {cmd!r}", code="UNKNOWN_CMD")


def main(argv=None) -> int:
    data_dir = os.environ.get("CLUSTER_DATA_DIR", "cluster_data")
    nodes = [n for n in os.environ.get("CLUSTER_NODES", "n1,n2,n3").split(",") if n]
    cluster = Cluster(nodes=nodes, data_dir=data_dir)
    had_error = False
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            result = handle(cluster, req)
        except ReplError as exc:
            had_error = True
            result = {"ok": False, "error": exc.code, "msg": exc.msg}
        except (KeyError, TypeError, ValueError) as exc:
            had_error = True
            result = {"ok": False, "error": "BAD_REQUEST", "msg": str(exc)}
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()
    return EXIT_ERROR if had_error else 0


if __name__ == "__main__":
    sys.exit(main())
