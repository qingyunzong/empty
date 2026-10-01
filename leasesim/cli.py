"""Command line interface: python -m leasesim run OPS.json --out STATE.json"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys

from .sim import SimError, Simulator


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_op(index, raw, resources):
    if not isinstance(raw, dict):
        raise SimError(f"op #{index}: must be an object")
    t = raw.get("t")
    if not _is_int(t) or t < 0:
        raise SimError(f"op #{index}: 't' must be a non-negative integer")
    client = raw.get("client")
    if not isinstance(client, str) or not client:
        raise SimError(f"op #{index}: 'client' must be a non-empty string")
    has_acquire = "acquire" in raw
    has_release = "release" in raw
    if has_acquire == has_release:
        raise SimError(
            f"op #{index}: exactly one of 'acquire' / 'release' is required")
    op = {"t": t, "client": client}
    if has_acquire:
        acquire = raw["acquire"]
        if not isinstance(acquire, dict) or not acquire:
            raise SimError(
                f"op #{index}: 'acquire' must be a non-empty object")
        for res, need in acquire.items():
            if not isinstance(res, str) or not res:
                raise SimError(f"op #{index}: invalid resource name {res!r}")
            if res not in resources:
                raise SimError(f"op #{index}: unknown resource {res!r}")
            if not _is_int(need):
                raise SimError(
                    f"op #{index}: need for {res!r} must be an integer")
        if "ttl" not in raw:
            raise SimError(f"op #{index}: 'ttl' is required for acquire")
        if not _is_int(raw["ttl"]) or raw["ttl"] < 0:
            raise SimError(
                f"op #{index}: 'ttl' must be a non-negative integer")
        op["acquire"] = dict(acquire)
        op["ttl"] = raw["ttl"]
    else:
        release = raw["release"]
        if not isinstance(release, list) or not release:
            raise SimError(
                f"op #{index}: 'release' must be a non-empty list")
        if len(set(release)) != len(release):
            raise SimError(f"op #{index}: duplicate entries in 'release'")
        for res in release:
            if not isinstance(res, str) or res not in resources:
                raise SimError(f"op #{index}: unknown resource {res!r}")
        op["release"] = list(release)
    return op


def load_spec(text):
    """Parse and validate an ops.json document.

    Returns (capacities, ops) with ops sorted by (t, client) and carrying
    a stable 'seq' index.  Raises SimError on any invalid input.
    """
    try:
        spec = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SimError(f"invalid JSON: {exc}") from exc
    if not isinstance(spec, dict):
        raise SimError("top level must be an object")
    resources = spec.get("resources")
    if not isinstance(resources, dict) or not resources:
        raise SimError("'resources' must be a non-empty object")
    for name, cap in resources.items():
        if not isinstance(name, str) or not name:
            raise SimError(f"invalid resource name: {name!r}")
        if not _is_int(cap) or cap < 1:
            raise SimError(
                f"resource {name!r}: capacity must be a positive integer")
    ops_raw = spec.get("ops")
    if not isinstance(ops_raw, list):
        raise SimError("'ops' must be a list")
    ops = []
    seen = set()
    for index, raw in enumerate(ops_raw):
        op = _validate_op(index, raw, resources)
        key = (op["t"], op["client"])
        if key in seen:
            raise SimError(
                f"duplicate op for (t={op['t']}, client={op['client']!r})")
        seen.add(key)
        ops.append(op)
    ops.sort(key=lambda o: (o["t"], o["client"]))
    for seq, op in enumerate(ops):
        op["seq"] = seq
    return resources, ops


def _fail(message):
    print(f"leasesim: error: {message}", file=sys.stderr)
    return 2


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="leasesim",
        description="Deterministic lease simulator.")
    sub = parser.add_subparsers(dest="command", required=True)
    run_p = sub.add_parser("run", help="run a simulation")
    run_p.add_argument("ops_file", help="input spec (JSON)")
    run_p.add_argument("--out", required=True, help="output state file (JSON)")
    args = parser.parse_args(argv)

    if args.command == "run":
        try:
            with open(args.ops_file, encoding="utf-8") as fh:
                text = fh.read()
        except OSError as exc:
            return _fail(str(exc))
        try:
            capacities, ops = load_spec(text)
            state = Simulator(capacities).run(ops)
        except SimError as exc:
            return _fail(str(exc))
        payload = json.dumps(state, indent=2, sort_keys=True) + "\n"
        try:
            with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(payload)
        except OSError as exc:
            return _fail(str(exc))
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        counts = {}
        for entry in state["results"]:
            counts[entry["result"]] = counts.get(entry["result"], 0) + 1
        summary = ", ".join(f"{k}={counts[k]}" for k in sorted(counts))
        print(f"wrote {args.out} ({summary or 'no events'}); "
              f"sha256={digest}")
        return 0
    return 2
