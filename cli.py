"""JSON-lines CLI for the PN-Counter cluster.

Reads one JSON object per line from stdin and writes one JSON object per
line to stdout.  Commands:

    {"cmd": "inc",    "node": "A", "k": 3}      -> {"ok": true, "value": V}
    {"cmd": "dec",    "node": "A", "k": 2}      -> {"ok": true, "value": V}
    {"cmd": "remove", "node": "A"}              -> {"ok": true}
    {"cmd": "merge",  "dst": "A", "src": "B"}   -> {"ok": true, "value": V}
    {"cmd": "value",  "node": "A"}              -> {"ok": true, "value": V}

Errors produce {"ok": false, "error": CODE} on stdout and the process
exits with status 8 if any line failed (remaining lines are still
processed).  Error codes: BAD_DELTA, REMOVED, ID_RETIRED, NO_MAJORITY,
NOT_FOUND, TOO_MANY_NODES, BAD_ARGS, BAD_COMMAND.
"""

from __future__ import annotations

import json
import sys

from pncounter import Cluster, ClusterError

EXIT_ERROR = 8


def handle(cluster: Cluster, req: dict) -> dict:
    if not isinstance(req, dict):
        raise ClusterError("BAD_COMMAND")
    cmd = req.get("cmd")
    if cmd == "inc":
        return {"ok": True, "value": cluster.inc(req.get("node"), req.get("k"))}
    if cmd == "dec":
        return {"ok": True, "value": cluster.dec(req.get("node"), req.get("k"))}
    if cmd == "remove":
        cluster.remove(req.get("node"))
        return {"ok": True}
    if cmd == "merge":
        if "dst" not in req or "src" not in req:
            raise ClusterError("BAD_ARGS")
        return {"ok": True, "value": cluster.merge(req.get("dst"), req.get("src"))}
    if cmd == "value":
        return {"ok": True, "value": cluster.value(req.get("node"))}
    raise ClusterError("BAD_COMMAND")


def main() -> int:
    cluster = Cluster()
    failed = False
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            req = None
        if req is None:
            resp = {"ok": False, "error": "BAD_COMMAND"}
            failed = True
        else:
            try:
                resp = handle(cluster, req)
            except ClusterError as exc:
                resp = {"ok": False, "error": exc.code}
                failed = True
            except Exception:  # defensive: never crash the protocol loop
                resp = {"ok": False, "error": "BAD_COMMAND"}
                failed = True
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return EXIT_ERROR if failed else 0


if __name__ == "__main__":
    sys.exit(main())
