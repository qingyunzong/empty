"""CLI: python -m rostersolve plan jobs.json --out plan.json --trace trace.json"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys

from . import model, solver


def _emit_error(message):
    sys.stderr.write(json.dumps({"error": message}) + "\n")
    return 2


def _run_plan(args):
    try:
        with open(args.input, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        return _emit_error(f"cannot read input: {exc.strerror or exc}")
    except json.JSONDecodeError as exc:
        return _emit_error(f"invalid JSON: {exc}")
    try:
        jobs, machines, horizon = model.load_instance(data)
    except model.InputError as exc:
        return _emit_error(str(exc))

    assign, search_trace = solver.solve(jobs, machines, horizon)

    if assign is not None:
        by_id = {j["id"]: j for j in jobs}
        schedule = {}
        for m in sorted(machines, key=lambda m: model.id_sort_key(m["id"])):
            schedule[m["id"]] = [None] * horizon
        makespan = 0
        for jid in sorted(assign, key=model.id_sort_key):
            mid, start = assign[jid]
            dur = by_id[jid]["duration"]
            for t in range(start, start + dur):
                schedule[mid][t] = jid
            makespan = max(makespan, start + dur)
        result = {
            "status": "FEASIBLE",
            "makespan": makespan,
            "horizon": horizon,
            "schedule": schedule,
        }
        conflict = None
    else:
        conflict = solver.minimal_conflict(jobs, machines, horizon)
        result = {"status": "INFEASIBLE", "conflict": conflict}

    out_text = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(out_text)
    else:
        sys.stdout.write(out_text)

    if args.trace:
        canonical = json.dumps(data, sort_keys=True).encode("utf-8")
        trace = {
            "input_sha256": hashlib.sha256(canonical).hexdigest(),
            "status": result["status"],
            "nodes": search_trace["nodes"],
            "events": search_trace["events"],
            "conflict": conflict,
        }
        with open(args.trace, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(trace, indent=2, sort_keys=True) + "\n")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="rostersolve")
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="solve a scheduling instance")
    plan.add_argument("input", help="path to the instance JSON file")
    plan.add_argument("--out", help="write the plan JSON here (default: stdout)")
    plan.add_argument("--trace", help="write the search trace JSON here")
    args = parser.parse_args(argv)
    if args.command == "plan":
        return _run_plan(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
