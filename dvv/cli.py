"""JSON command-line interface.

Usage:
    python -m dvv script.json            run a script, print results+log+digest
    python -m dvv --replay run.json      replay the log of a previous run
    python -m dvv --check script.json    run, then exhaustively verify the
                                         produced events against the event DAG
"""
from __future__ import annotations

import json
import sys

from .enumcheck import verify
from .network import Network


def run_script(script):
    net = Network()
    results = []
    events = []
    for op in script["ops"]:
        name = op["op"]
        if name == "add_node":
            net.add_node(op["node"])
        elif name == "put":
            events.append(net.put(op["node"], op["key"], op.get("value"),
                                  op.get("delay", 0), op.get("duplicates", 1)))
        elif name == "delete":
            events.append(net.delete(op["node"], op["key"],
                                     op.get("delay", 0), op.get("duplicates", 1)))
        elif name == "read":
            results.append({"node": op["node"], "key": op["key"],
                            "values": net.read(op["node"], op["key"])})
        elif name == "ack":
            net.send_acks(op["node"])
        elif name == "partition":
            net.partition(op["a"], op["b"])
        elif name == "heal":
            net.heal(op["a"], op["b"])
        elif name == "deliver":
            results.append(net.deliver_next())
        elif name == "run":
            results.append({"delivered": net.run()})
        elif name == "advance":
            net.advance(op.get("steps", 1))
        elif name == "resync":
            net.resync(op["node"])
        elif name == "snapshot":
            net.snapshot(op["node"], op.get("name"))
        elif name == "restore":
            net.restore(op["node"], op["name"])
        elif name == "gc":
            results.append({"node": op["node"], "reclaimed": net.gc(op["node"])})
        elif name == "retire":
            net.retire(op["node"])
        elif name == "rejoin":
            net.rejoin(op["node"])
        else:
            raise ValueError(f"unknown op: {name!r}")
    return net, results, events


def cmd_run(path):
    with open(path) as fh:
        script = json.load(fh)
    net, results, _events = run_script(script)
    return {"results": results, "log": net.log, "digest": net.digest()}


def cmd_replay(path):
    with open(path) as fh:
        previous = json.load(fh)
    net = Network.replay(previous["log"])
    digest = net.digest()
    return {"digest": digest,
            "match": digest == previous.get("digest", digest)}


def cmd_check(path):
    with open(path) as fh:
        script = json.load(fh)
    _net, _results, events = run_script(script)
    report = verify(events)
    if "relations" in report:
        rel = report["relations"]
        report["relations"] = {"before": len(rel["before"]),
                               "concurrent": len(rel["concurrent"])}
    return report


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print(__doc__)
        return 2
    if argv[0] == "--replay":
        output = cmd_replay(argv[1])
    elif argv[0] == "--check":
        output = cmd_check(argv[1])
    else:
        output = cmd_run(argv[0])
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    if isinstance(output, dict) and output.get("status") == "fail":
        return 1
    if isinstance(output, dict) and output.get("match") is False:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
