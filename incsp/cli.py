"""Command-line interface for the incremental shortest-path engine.

Reads commands from a file given as the first argument, or from stdin:

    edge u v w   add directed edge u->v with integer weight 0..10^6
    rm u v       remove the logical edge u->v
    src s        set (or switch) the source node; clears cached results
    dist t       print shortest distance to t, or INF when unreachable
    path t       print the lexicographically smallest shortest node
                 sequence to t (space separated), or an empty line
    recomputed   print how many nodes the last update recomputed

Unknown nodes are created automatically; self-loops are allowed.
Exit code is 0 on success (including INF / empty path) and 2 on any
error such as a negative weight or a malformed command.
"""

from __future__ import annotations

import sys
from typing import Iterable, TextIO

from .engine import IncrementalSSSP


def run(lines: Iterable[str], out: TextIO) -> int:
    eng = IncrementalSSSP()
    results: list[str] = []
    for lineno, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        cmd, args = parts[0], parts[1:]
        try:
            if cmd == "edge":
                u, v, w_text = args
                eng.add_edge(u, v, int(w_text))
            elif cmd == "rm":
                u, v = args
                eng.remove_edge(u, v)
            elif cmd == "src":
                (s,) = args
                eng.set_source(s)
            elif cmd == "dist":
                (t,) = args
                d = eng.dist(t)
                results.append("INF" if d is None else str(d))
            elif cmd == "path":
                (t,) = args
                p = eng.path(t)
                results.append("" if p is None else " ".join(p))
            elif cmd == "recomputed":
                results.append(str(eng.recomputed))
            else:
                raise ValueError(f"unknown command {cmd!r}")
        except ValueError as exc:
            print(f"error: line {lineno}: {exc}", file=sys.stderr)
            return 2
    if results:
        out.write("\n".join(results) + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv:
        try:
            with open(argv[0], "r", encoding="utf-8") as fh:
                lines = fh.read().splitlines()
        except OSError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    else:
        lines = sys.stdin.read().splitlines()
    return run(lines, sys.stdout)
