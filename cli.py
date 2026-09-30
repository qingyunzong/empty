"""JSON-lines CLI for the PN-Counter.

Reads one JSON command per line from stdin, writes one JSON result per line
to stdout. Exit code is 8 if any command failed, 0 otherwise.

Commands (replicas are created lazily by name):
  {"cmd": "add",    "replica": "r1", "node": "A"}
  {"cmd": "inc",    "replica": "r1", "node": "A", "k": 3}
  {"cmd": "dec",    "replica": "r1", "node": "A", "k": 2}
  {"cmd": "remove", "replica": "r1", "node": "B", "voters": ["A", "C"]}
  {"cmd": "merge",  "replica": "r1", "from": "r2"}
  {"cmd": "value",  "replica": "r1"}
  {"cmd": "state",  "replica": "r1"}
"""

import json
import sys

from pncounter import PNCounter, PNCounterError

EXIT_ERROR = 8


class CliError(Exception):
    code = "BAD_COMMAND"


def _require(obj, *keys):
    for key in keys:
        if key not in obj:
            raise CliError("MISSING_FIELD:" + key)
    return [obj[k] for k in keys]


def run_line(replicas, cmd):
    if not isinstance(cmd, dict):
        raise CliError("BAD_COMMAND")
    op = cmd.get("cmd")
    if op == "value":
        (name,) = _require(cmd, "replica")
        return {"ok": True, "value": replicas.setdefault(name, PNCounter()).value()}
    if op == "state":
        (name,) = _require(cmd, "replica")
        return {"ok": True, "state": replicas.setdefault(name, PNCounter()).state()}
    if op == "merge":
        name, src = _require(cmd, "replica", "from")
        if src not in replicas:
            raise CliError("UNKNOWN_REPLICA")
        replicas.setdefault(name, PNCounter()).merge(replicas[src].copy())
        return {"ok": True}
    replica = replicas.setdefault(cmd.get("replica"), PNCounter()) if "replica" in cmd else None
    if replica is None:
        raise CliError("MISSING_FIELD:replica")
    if op == "add":
        (node,) = _require(cmd, "node")
        replica.add_node(node)
    elif op == "inc":
        node, k = _require(cmd, "node", "k")
        replica.inc(node, k)
    elif op == "dec":
        node, k = _require(cmd, "node", "k")
        replica.dec(node, k)
    elif op == "remove":
        node, voters = _require(cmd, "node", "voters")
        if not isinstance(voters, list):
            raise CliError("BAD_VOTERS")
        replica.remove_node(node, voters)
    else:
        raise CliError("BAD_COMMAND")
    return {"ok": True}


def main(stream=None, out=None):
    stream = stream if stream is not None else sys.stdin
    out = out if out is not None else sys.stdout
    replicas = {}
    failed = False
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            result = {"ok": False, "error": "BAD_JSON"}
            failed = True
            out.write(json.dumps(result) + "\n")
            continue
        try:
            result = run_line(replicas, cmd)
        except PNCounterError as exc:
            result = {"ok": False, "error": exc.code}
            failed = True
        except CliError as exc:
            result = {"ok": False, "error": exc.code}
            failed = True
        out.write(json.dumps(result) + "\n")
    out.flush()
    return EXIT_ERROR if failed else 0


if __name__ == "__main__":
    sys.exit(main())
