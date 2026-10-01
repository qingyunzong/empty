"""JSON command-line interface for the CRDT simulator."""
from __future__ import annotations

import argparse
import json
import sys

from .enumerate import WriteSpec, check_scenario
from .sim import Sim


def _load(path):
    if path:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    return json.load(sys.stdin)


def _state(sim):
    return {
        node: replica.snapshot()
        for node, replica in sorted(sim.replicas.items())
    }


def cmd_run(scenario):
    sim = Sim()
    reads = []
    snapshots = {}
    for step in scenario:
        op = step["op"]
        args = {k: v for k, v in step.items() if k != "op"}
        if op == "read":
            value = sim.read(args["node"], args["key"])
            reads.append({"node": args["node"], "key": args["key"],
                          "values": value})
        elif op == "snapshot":
            snapshots[args["node"]] = sim.snapshot(args["node"])
        elif op == "restore":
            sim.restore(args["node"], snapshots[args["node"]])
        elif op == "gc":
            sim.gc(args["node"])
        else:
            getattr(sim, op)(**args)
    return {
        "log": sim.log,
        "reads": reads,
        "state": _state(sim),
        "fingerprint": sim.fingerprint(),
    }


def cmd_replay(log):
    sim = Sim.replay(log)
    return {"fingerprint": sim.fingerprint(), "state": _state(sim)}


def cmd_enumerate(spec):
    nodes = spec["nodes"]
    writes = [
        WriteSpec(w["id"], w["node"], w["key"], tuple(w.get("deps", ())))
        for w in spec["writes"]
    ]
    result = check_scenario(nodes, writes, spec.get("limit", 200000))
    return {
        "ok": result.ok,
        "checked": result.checked,
        "counterexample": result.counterexample,
        "detail": result.detail,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(prog="crdtsim")
    parser.add_argument("command", choices=["run", "replay", "enumerate"])
    parser.add_argument("path", nargs="?")
    args = parser.parse_args(argv)
    payload = _load(args.path)
    if args.command == "run":
        output = cmd_run(payload)
    elif args.command == "replay":
        output = cmd_replay(payload)
    else:
        output = cmd_enumerate(payload)
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
