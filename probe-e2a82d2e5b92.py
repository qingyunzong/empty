"""Focused CLI checks for the B artifact; all state is written under /tmp."""

import argparse
import json
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path


PYTHON = "/home/delin/.local/bin/python3.11"

CASES = {
    "reacquire": {
        "resources": {"r": 1, "other": 1},
        "ops": [
            {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 3},
            {"t": 1, "client": "a", "release": ["r"]},
            {"t": 2, "client": "a", "acquire": {"r": 1}, "ttl": 10},
            {"t": 3, "client": "b", "acquire": {"r": 1}, "ttl": 10},
        ],
    },
    "zero_ttl": {
        "resources": {"r": 1},
        "ops": [
            {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 0},
            {"t": 0, "client": "b", "acquire": {"r": 1}, "ttl": 0},
        ],
    },
    "queue": {
        "resources": {"r": 1, "s": 1},
        "ops": [
            {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 10},
            {"t": 1, "client": "b", "acquire": {"r": 1}, "ttl": 10},
            {"t": 2, "client": "c", "acquire": {"s": 1}, "ttl": 10},
        ],
    },
}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run(case):
    with tempfile.TemporaryDirectory(prefix="leasesim-probe-") as tmp:
        source = Path(tmp) / "ops.json"
        target = Path(tmp) / "state.json"
        source.write_text(json.dumps(CASES[case]), encoding="utf-8")
        result = subprocess.run(
            [PYTHON, "-m", "leasesim", "run", str(source), "--out", str(target)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        require(result.returncode == 0, f"CLI exit={result.returncode}: {result.stderr.strip()}")
        require(target.is_file(), "CLI exited 0 without writing state.json")
        return json.loads(target.read_text(encoding="utf-8"))


def check(case, state):
    events = state["results"]
    counts = Counter(e["result"] for e in events)
    holders = state["holders"]
    if case == "reacquire":
        b_ops = [e for e in events if e["client"] == "b" and e["kind"] == "acquire"]
        require(len(b_ops) == 1 and b_ops[0]["result"] == "WAITING", f"b result={b_ops}")
        require(holders.get("a", {}).get("resources") == {"r": 1}, f"holders={holders}")
        expiry = holders["a"]["expires_at"].get("r")
        require(expiry == 12, f"a.r expiry={expiry}")
        require(not any(e["result"] == "EXPIRED" and e["client"] == "a" for e in events),
                f"a expired early: {events}")
        amount = holders["a"]["resources"]["r"]
        print(f"b={b_ops[0]['result']} a.r={amount} expires_at={expiry} EXPIRED={counts['EXPIRED']}")
    elif case == "zero_ttl":
        b_grants = [e for e in events if e["client"] == "b" and e["result"] == "GRANTED"]
        b_expiries = [e for e in events if e["client"] == "b" and e["result"] == "EXPIRED"]
        require(len(b_grants) == 1 and b_grants[0]["t"] == 0, f"b grants={b_grants}")
        require(len(b_expiries) == 1 and b_expiries[0]["t"] == 0, f"b expiries={b_expiries}")
        require(holders == {}, f"holders={holders}")
        print(f"b GRANTED={len(b_grants)} EXPIRED={len(b_expiries)} t={b_expiries[0]['t']} holders={holders}")
    else:
        c_ops = [e for e in events if e["client"] == "c" and e["kind"] == "acquire"]
        require(len(c_ops) == 1 and c_ops[0]["result"] == "WAITING", f"c result={c_ops}")
        require(holders == {"a": {"resources": {"r": 1}, "expires_at": {"r": 10}}},
                f"holders={holders}")
        require(counts["GRANTED"] == 1 and counts["WAITING"] == 2,
                f"counts={dict(counts)}")
        print(f"c={c_ops[0]['result']} GRANTED={counts['GRANTED']} WAITING={counts['WAITING']} holders={list(holders)}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("case", choices=CASES)
    args = parser.parse_args()
    try:
        check(args.case, run(args.case))
    except (AssertionError, KeyError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f"FAIL {args.case}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
