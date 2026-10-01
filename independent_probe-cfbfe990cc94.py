"""Read-only CLI probes against the submitted A/B commits; outputs use /tmp."""
import json
import subprocess
import tempfile
from pathlib import Path

PYTHON = "/home/delin/.local/bin/python3.11"
ROOT = Path("/home/delin/.local/share/gsb-workbench/artifacts/b6a192526d2c4a259f98ab44e5535945/run")
WORKSPACES = {
    "A": ROOT / "A/attempt-024/workspace",
    "B": ROOT / "B/attempt-023/workspace",
}
CASES = {
    "old_lease_after_reacquire": {
        "resources": {"r": 1, "other": 1},
        "ops": [
            {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 3},
            {"t": 1, "client": "a", "release": ["r"]},
            {"t": 2, "client": "a", "acquire": {"r": 1}, "ttl": 10},
            {"t": 3, "client": "b", "acquire": {"r": 1}, "ttl": 10},
        ],
    },
    "zero_ttl_queued_grant": {
        "resources": {"r": 1},
        "ops": [
            {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 0},
            {"t": 0, "client": "b", "acquire": {"r": 1}, "ttl": 0},
        ],
    },
    "blocked_queue_head": {
        "resources": {"r": 1, "s": 1},
        "ops": [
            {"t": 0, "client": "a", "acquire": {"r": 1}, "ttl": 10},
            {"t": 1, "client": "b", "acquire": {"r": 1}, "ttl": 10},
            {"t": 2, "client": "c", "acquire": {"s": 1}, "ttl": 10},
        ],
    },
}

print("interpreter:", subprocess.run([PYTHON, "--version"], capture_output=True, text=True).stdout.strip())
for name, case in CASES.items():
    print("CASE", name, "INPUT", json.dumps(case, sort_keys=True, ensure_ascii=False))
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "ops.json"
        source.write_text(json.dumps(case), encoding="utf-8")
        for side, workspace in WORKSPACES.items():
            output = Path(tmp) / (side + ".json")
            command = [PYTHON, "-m", "leasesim", "run", str(source), "--out", str(output)]
            result = subprocess.run(command, cwd=workspace, capture_output=True, text=True)
            print("SIDE", side, "SHA", subprocess.run(["git", "rev-parse", "HEAD"], cwd=workspace, capture_output=True, text=True).stdout.strip())
            print("COMMAND", json.dumps(command))
            print("EXIT", result.returncode)
            print("STDOUT", repr(result.stdout))
            print("STDERR", repr(result.stderr))
            print("STATE", output.read_text() if output.exists() else "<absent>")
