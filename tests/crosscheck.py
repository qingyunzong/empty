#!/usr/bin/env python3
"""Cross-check idxcheck (C++) against oracle.py (arbitrary precision).

Usage: crosscheck.py <idxcheck-binary> <fixtures-dir> <case>

Runs idxcheck on <fixtures-dir>/<case>.idx (plus <case>.data when it
exists) and verifies that the RESULT verdict and exit code match the
oracle's expectation exactly.
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oracle import expected_result  # noqa: E402


def main(argv):
    if len(argv) != 4:
        print(f"usage: {argv[0]} <idxcheck> <fixtures-dir> <case>", file=sys.stderr)
        return 2
    idxcheck, fixtures, case = argv[1], argv[2], argv[3]
    index_path = os.path.join(fixtures, case + ".idx")
    data_path = os.path.join(fixtures, case + ".data")

    with open(index_path, "rb") as fh:
        index_bytes = fh.read()
    data_size = None
    args = [idxcheck, index_path]
    if os.path.exists(data_path):
        data_size = os.path.getsize(data_path)
        args += ["--data", data_path]

    want_code, want_msg = expected_result(index_bytes, data_size)

    proc = subprocess.run(args, capture_output=True, text=True)
    result_lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT: ")]
    if len(result_lines) != 1:
        print(f"FAIL {case}: expected exactly one RESULT line, got:\n{proc.stdout}")
        return 1
    got = result_lines[0]

    want = "RESULT: OK" if want_code == "OK" else f"RESULT: INVALID {want_code}"
    want_exit = 0 if want_code == "OK" else 1

    ok = True
    if not got.startswith(want):
        print(f"FAIL {case}: verdict mismatch\n  idxcheck: {got}\n  oracle:   {want}")
        ok = False
    if proc.returncode != want_exit:
        print(f"FAIL {case}: exit code {proc.returncode}, oracle expects {want_exit}")
        ok = False
    if not ok:
        print("--- idxcheck stdout ---")
        print(proc.stdout)
        return 1
    print(f"PASS {case}: {got} (exit {proc.returncode})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
