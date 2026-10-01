"""Check whether the delivered CLI preserves service order within one tick."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


events = [
    {"type": "capacity", "t": 0, "c": 4},
    {"type": "submit", "t": 0, "flow": 1, "size": 3, "prio": 1},
    {"type": "submit", "t": 0, "flow": 2, "size": 3, "prio": 1},
    {"type": "tick", "t": 1},
]


def expected_units():
    served = {1: 0, 2: 0}
    order = []
    for _ in range(4):
        flow = min(served, key=lambda fid: (served[fid], fid))
        served[flow] += 1
        order.append(flow)
    return order


with tempfile.TemporaryDirectory(prefix="fairq-sequence-") as tmp:
    root = Path(tmp)
    source = root / "events.json"
    result_file = root / "result.json"
    log_file = root / "log.txt"
    source.write_text(json.dumps(events), encoding="utf-8")
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    completed = subprocess.run(
        [sys.executable, "-B", "-m", "fairq", "run", str(source),
         "--out", str(result_file), "--log", str(log_file)],
        capture_output=True, text=True, env=env, timeout=10,
    )
    assert completed.returncode == 0, (
        f"CLI exit={completed.returncode} stderr={completed.stderr.strip()}"
    )
    result = json.loads(result_file.read_text(encoding="utf-8"))
    log = log_file.read_text(encoding="utf-8").splitlines()

expected = expected_units()
service = result["service"]
actual_rows = [row for row in service if row["t"] == 1]
actual_counts = {row["flow"]: row["units"] for row in actual_rows}
assert actual_counts == {1: 2, 2: 2}, f"unexpected service totals: {actual_rows}"
assert len(actual_rows) == 2, f"unexpected service rows: {actual_rows}"
log_rows = [line for line in log if line.startswith("tick t=1 serve")]
assert len(log_rows) == 2, f"unexpected log service rows: {log_rows}"
assert set(log_rows) == {
    "tick t=1 serve flow=1 units=2",
    "tick t=1 serve flow=2 units=2",
}, f"unexpected log content: {log_rows}"
reported_expansion = [row["flow"] for row in actual_rows for _ in range(row["units"])]
assert reported_expansion != expected, (
    f"precise unit order is now available: {actual_rows}"
)
assert expected == [1, 2, 1, 2], f"reference scheduling changed: {expected}"
print(f"逐单位应为: {expected}")
print(f"结果服务记录: {actual_rows}")
print(f"日志服务记录: {log_rows}")
print("复现：两种交付输出均只保留每流总量，丢失 tick 内交错顺序")
