"""Reproduce recovery after an ordinary, uncommitted begin command."""

import json
import os
import subprocess
import sys
import tempfile


def run_cli(data_dir, commands):
    env = os.environ.copy()
    env["CLUSTER_DATA_DIR"] = data_dir
    env["CLUSTER_NODES"] = "a,b,c"
    env.pop("SIM_CRASH_BEFORE_CONFIG_FSYNC", None)
    payload = "".join(json.dumps(command) + "\n" for command in commands)
    result = subprocess.run(
        [sys.executable, "-m", "repligroup"],
        input=payload,
        text=True,
        capture_output=True,
        env=env,
        timeout=5,
    )
    if result.returncode != 0:
        raise AssertionError(f"CLI exited {result.returncode}: {result.stderr.strip()}")
    return [json.loads(line) for line in result.stdout.splitlines()]


def main():
    with tempfile.TemporaryDirectory() as data_dir:
        initial = run_cli(data_dir, [
            {"cmd": "write", "value": "durable"},
            {"cmd": "read"},
            {"cmd": "begin", "old": ["a", "b", "c"], "new": ["a", "b", "d"]},
        ])
        if len(initial) != 3 or not initial[0].get("committed"):
            raise AssertionError(f"initial write failed: {initial}")
        before, begin = initial[1:]
        if (before.get("phase"), before.get("epoch"), before.get("committed")) != (
            "stable", 1, ["durable"]
        ) or (begin.get("phase"), begin.get("epoch")) != ("joint", 2):
            raise AssertionError(f"unexpected setup: {initial}")
        recovered = run_cli(data_dir, [{"cmd": "read"}])
        if len(recovered) != 1:
            raise AssertionError(f"unexpected recovery output: {recovered}")
        state = recovered[0]
        print(f"before: phase={before['phase']} epoch={before['epoch']} committed={before['committed']}")
        print(f"restart: phase={state.get('phase')} epoch={state.get('epoch')} "
              f"members={state.get('members')} committed={state.get('committed')}")
        if (state.get("phase"), state.get("epoch"), state.get("members"),
                state.get("committed")) != ("joint", 2, ["a", "b", "c"], ["durable"]):
            raise AssertionError("uncommitted joint configuration did not survive restart")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, subprocess.TimeoutExpired, OSError, ValueError) as exc:
        print(f"probe failed: {exc}", file=sys.stderr)
        sys.exit(1)
