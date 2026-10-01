"""Independent, bounded checks of the delivered B-side behavior."""

import json
import os
import struct
import subprocess
import sys
import tempfile
import zlib

sys.dont_write_bytecode = True
sys.path.insert(0, os.getcwd())


def entry(value):
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return struct.pack(">I", len(payload)) + payload + struct.pack(">I", zlib.crc32(payload))


def recovery_check():
    first = [{"var": "x", "value": 1}]
    invalid = {"unexpected": "not a Nogood clause"}
    third = [{"var": "y", "value": 2}]
    with tempfile.TemporaryDirectory() as temp:
        path = os.path.join(temp, "nogoods.log")
        with open(path, "wb") as handle:
            handle.write(entry(first) + entry(invalid) + entry(third))
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run(
            [sys.executable, "-m", "csp_persist", "load", "--log", path],
            cwd=os.getcwd(), env=env, capture_output=True, text=True,
            timeout=5,
        )
    if result.returncode != 0:
        raise AssertionError(f"CLI exit={result.returncode}: {result.stderr.strip()}")
    loaded = json.loads(result.stdout)
    invalid_loaded = sum(item == invalid for item in loaded)
    later_loaded = sum(item == third for item in loaded)
    print(f"恢复条目数={len(loaded)}; 非法第二条={invalid_loaded}; 后续第三条={later_loaded}")
    if loaded != [first, invalid, third]:
        raise AssertionError(f"未复现 GSB 所述恢复结果: {loaded!r}")


def counter_check():
    from csp_persist.solver import CSPSolver

    solver = CSPSolver({"x": [0, 1]})
    solver.add_nogood([{"var": "x", "value": 0}])
    first_solutions = solver.solve()
    first_count = solver.pruned_nodes
    second_solutions = solver.solve()
    second_count = solver.pruned_nodes
    print(f"首轮剪枝={first_count}; 次轮累计剪枝={second_count}; 解数={len(second_solutions)}")
    if first_solutions != second_solutions or first_count != 1 or second_count != 2:
        raise AssertionError("未复现重复求解时计数累加")


if __name__ == "__main__":
    try:
        {"recovery": recovery_check, "counter": counter_check}[sys.argv[1]]()
    except (IndexError, KeyError, AssertionError, ValueError) as exc:
        print(f"检查失败: {exc}", file=sys.stderr)
        sys.exit(1)
