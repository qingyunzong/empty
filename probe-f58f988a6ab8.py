"""Focused, independent checks of the delivered incremental graph."""

import json
import os
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.getcwd())
from incsp import IncrementalGraph


def check(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: actual={actual!r}, expected={expected!r}")


def locality():
    g = IncrementalGraph()
    g.set_source("s")
    for u, v, w in [("s", "a", 1), ("s", "b", 1),
                    ("a", "t", 1), ("b", "t", 1)]:
        g.add_edge(u, v, w)
    previous = "t"
    for i in range(100):
        current = f"n{i:03d}"
        g.add_edge(previous, current, 0)
        previous = current
    tail = previous
    before = (g.distance("t"), g.path("t"), g.distance(tail), g.path(tail))
    changed = g.remove_edge("s", "b")
    after = (g.distance("t"), g.path("t"), g.distance(tail), g.path(tail))
    result = {"removed": changed, "recomputed": g.last_recomputed,
              "t_distance": after[0], "t_path": after[1],
              "tail_distance": after[2], "tail_path_length": len(after[3]),
              "b_distance": str(g.distance("b"))}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    check(changed, True, "edge removed")
    check(before, after, "supported path and zero-weight tail")
    check(after[0], 2, "target distance")
    check(after[1], ["s", "a", "t"], "target path")
    check(after[2], 2, "tail distance")
    check(len(after[3]), 103, "tail path length")
    check(g.distance("b"), float("inf"), "unsupported vertex")
    check(g.last_recomputed, 1, "affected count")


def cli_semantics():
    script = "\n".join([
        "src s", "edge s b 1", "edge s a 1", "edge b t 1",
        "edge a t 1", "dist t", "path t", "edge s a 3", "path t",
        "rm s a", "path t", "rm s b", "dist t", "path t", "",
    ])
    completed = subprocess.run([sys.executable, "-m", "incsp"],
                               input=script, text=True, capture_output=True,
                               timeout=5,
                               env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    lines = completed.stdout.splitlines()
    result = {"exit": completed.returncode, "lines": lines,
              "stderr": completed.stderr}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    check(completed.returncode, 0, "CLI exit")
    check(completed.stderr, "", "CLI stderr")
    check(lines, ["2", "s a t", "s a t", "s b t", "INF", ""],
          "CLI output")


if __name__ == "__main__":
    try:
        {"locality": locality, "cli": cli_semantics}[sys.argv[1]]()
    except (AssertionError, KeyError, IndexError, subprocess.TimeoutExpired) as exc:
        print(f"CHECK FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
