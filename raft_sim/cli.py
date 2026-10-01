"""JSON-lines CLI for the replicated-log simulator.

Reads one JSON command per line from stdin, writes one JSON result per line
to stdout.  Any command error prints {"ok": false, "error": ...} to stderr
and exits with status 11.  Protocol-level negative outcomes (e.g. an ack
REJECT) are normal results and exit 0.

Commands:
  {"cmd": "init",    "nodes": 3}
  {"cmd": "elect",   "candidate": "n1", "term": 1,
                     "fault": {"node": "n2", "point": "before_vote_persist"}}
  {"cmd": "append",  "key": "k", "value": 1, "leader": "n1"}   # leader optional
  {"cmd": "ack",     "follower": "n2", "leader": "n1"}         # leader optional
  {"cmd": "commit",  "leader": "n1"}                           # leader optional
  {"cmd": "crash",   "node": "n2"}
  {"cmd": "recover", "node": "n2"}
  {"cmd": "repair",  "leader": "n1"}                           # leader optional
  {"cmd": "state"}
"""
from __future__ import annotations

import json
import sys

from .core import Cluster, ProtocolError

EXIT_ERROR = 11


def _req(obj: dict, field: str):
    if field not in obj:
        raise ProtocolError(f"{obj.get('cmd')}: missing field {field!r}")
    return obj[field]


def dispatch(cluster, obj):
    """Execute one command; returns (cluster, result_dict)."""
    if not isinstance(obj, dict):
        raise ProtocolError("command must be a JSON object")
    cmd = obj.get("cmd")
    if cmd == "init":
        cluster = Cluster(_req(obj, "nodes"))
        return cluster, {"nodes": cluster.size}
    if cluster is None:
        raise ProtocolError(f"{cmd}: cluster not initialized, send init first")
    if cmd == "elect":
        return cluster, cluster.elect(_req(obj, "candidate"),
                                      _req(obj, "term"), obj.get("fault"))
    if cmd == "append":
        return cluster, cluster.append(_req(obj, "key"), obj.get("value"),
                                       obj.get("leader"))
    if cmd == "ack":
        return cluster, cluster.ack(_req(obj, "follower"), obj.get("leader"))
    if cmd == "commit":
        return cluster, cluster.commit(obj.get("leader"))
    if cmd == "crash":
        return cluster, cluster.crash(_req(obj, "node"))
    if cmd == "recover":
        return cluster, cluster.recover(_req(obj, "node"))
    if cmd == "repair":
        return cluster, cluster.repair(obj.get("leader"))
    if cmd == "state":
        return cluster, cluster.state()
    raise ProtocolError(f"unknown command: {cmd!r}")


def _fail(message: str) -> "SystemExit":
    print(json.dumps({"ok": False, "error": message}), file=sys.stderr)
    return SystemExit(EXIT_ERROR)


def main(argv=None) -> None:
    cluster = None
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise _fail(f"invalid JSON: {exc}")
        try:
            cluster, result = dispatch(cluster, obj)
        except ProtocolError as exc:
            raise _fail(str(exc))
        print(json.dumps({"ok": True, **result}))
    raise SystemExit(0)


if __name__ == "__main__":
    main()
