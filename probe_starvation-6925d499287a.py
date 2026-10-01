"""Reproduce the completion-time starvation boundary through the fairq CLI."""

import json
import subprocess
import sys
import tempfile
from pathlib import Path


events = [
    {"type": "submit", "t": 0, "flow": 1, "size": 1, "prio": 1},
    {"type": "tick", "t": 101},
]

with tempfile.TemporaryDirectory(prefix="fairq-starvation-") as directory:
    directory = Path(directory)
    source = directory / "events.json"
    result_path = directory / "result.json"
    log_path = directory / "log.txt"
    source.write_text(json.dumps(events), encoding="utf-8")
    completed = subprocess.run(
        [sys.executable, "-m", "fairq", "run", str(source),
         "--out", str(result_path), "--log", str(log_path)],
        text=True, capture_output=True, check=False,
    )
    if completed.returncode != 0:
        raise SystemExit(f"CLI failed: exit={completed.returncode} stderr={completed.stderr.strip()}")
    result = json.loads(result_path.read_text(encoding="utf-8"))
    log = log_path.read_text(encoding="utf-8").splitlines()

finish = result["flows"]["1"]["finish_t"]
starved = result["starved"]
served_at_finish = any(line.startswith("t=101 tick serve flow=1 ") for line in log)
print(f"等待时间=101，阈值={result['window']}；完成时刻={finish}")
print(f"实际饥饿名单={json.dumps(starved, ensure_ascii=False)}；完成时获得服务={served_at_finish}")
if 101 > result["window"] and finish == 101 and served_at_finish and 1 not in starved:
    print("复现：超时后完成的流未列入饥饿名单")
else:
    raise SystemExit("未复现：产物已报告该流饥饿，或边界条件未成立")
