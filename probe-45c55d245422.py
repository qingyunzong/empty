"""Independent CLI checks for the three A-side cases cited in evidence.json."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


CASES = {
    "old_lease": {
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
    "queue_order": {
        "resources": {"r": 1, "s": 1},
        "ops": [
            {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 10},
            {"t": 1, "client": "b", "acquire": {"r": 1}, "ttl": 10},
            {"t": 2, "client": "c", "acquire": {"s": 1}, "ttl": 10},
        ],
    },
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in CASES:
        print("usage: probe.py old_lease|zero_ttl|queue_order", file=sys.stderr)
        return 2
    case = sys.argv[1]
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "ops.json"
        output = Path(tmp) / "state.json"
        source.write_text(json.dumps(CASES[case]), encoding="utf-8")
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        run = subprocess.run(
            ["/home/delin/.local/bin/python3.11", "-m", "leasesim", "run",
             str(source), "--out", str(output)],
            text=True, capture_output=True, env=env, timeout=10,
        )
        if run.returncode != 0 or not output.exists():
            print(f"CLI exit={run.returncode}; stderr={run.stderr.strip()}")
            return 1
        state = json.loads(output.read_text(encoding="utf-8"))

    events = state["events"]
    holders = state["holders"]
    if case == "old_lease":
        observed = (any(e["client"] == "a" and e["result"] == "EXPIRED"
                        and e["t"] == 3 for e in events)
                    and any(e["client"] == "b" and e["result"] == "GRANTED"
                            and e["t"] == 3 for e in events)
                    and holders.get("b", {}).get("r") == 1
                    and "a" not in holders)
        print(f"旧租约到期后：a到期事件={sum(e['client']=='a' and e['result']=='EXPIRED' and e['t']==3 for e in events)}，"
              f"b获批事件={sum(e['client']=='b' and e['result']=='GRANTED' and e['t']==3 for e in events)}，"
              f"最终持有者={json.dumps(holders, ensure_ascii=False, sort_keys=True)}")
    elif case == "zero_ttl":
        b_grants = sum(e["client"] == "b" and e["result"] == "GRANTED" for e in events)
        b_expires = sum(e["client"] == "b" and e["result"] == "EXPIRED" for e in events)
        observed = b_grants == 1 and b_expires == 0 and holders.get("b", {}).get("r") == 1
        print(f"零TTL排队请求：b获批={b_grants}，b到期={b_expires}，"
              f"最终持有者={json.dumps(holders, ensure_ascii=False, sort_keys=True)}")
    else:
        b_waits = sum(e["client"] == "b" and e["result"] == "WAITING" for e in events)
        c_grants = sum(e["client"] == "c" and e["result"] == "GRANTED" for e in events)
        observed = (b_waits == 1 and c_grants == 1
                    and any(w["client"] == "b" for w in state["waiting"])
                    and holders.get("c", {}).get("s") == 1)
        print(f"等待队列：b等待={b_waits}，c获批={c_grants}，"
              f"最终持有者={json.dumps(holders, ensure_ascii=False, sort_keys=True)}")
    if not observed:
        print("未复现该问题", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
