"""Command line interface for the incremental shortest path engine.

Reads commands from stdin (or a script file given as argv[1]), one per line:

    edge u v w     add/update directed edge u->v with integer weight 0..10^6
                   (duplicate edges keep the minimum weight, one change)
    rm u v         remove edge u->v (missing edge is a no-op)
    src s          set the source node (clears all cached distances)
    dist t         print shortest distance to t, or INF
    path t         print lexicographically smallest shortest-path node
                   sequence (space separated); empty line if unreachable
    recomputed     print how many vertices the last mutation re-finalized

Unknown nodes are created automatically; self-loops are allowed.
Errors (negative/out-of-range weight, malformed command) exit with code 2.
"""

from __future__ import annotations

import sys

from .graph import INF, MAX_WEIGHT, IncrementalGraph


def _fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    return 2


def run(stream, out):
    g = IncrementalGraph()
    for lineno, raw in enumerate(stream, 1):
        parts = raw.split()
        if not parts or parts[0].startswith("#"):
            continue
        cmd, args = parts[0], parts[1:]
        if cmd == "edge" and len(args) == 3:
            u, v = args[0], args[1]
            try:
                w = int(args[2])
            except ValueError:
                return _fail(f"line {lineno}: weight must be an integer, got {args[2]!r}")
            if not 0 <= w <= MAX_WEIGHT:
                return _fail(f"line {lineno}: weight {w} out of range 0..{MAX_WEIGHT}")
            g.add_edge(u, v, w)
        elif cmd == "rm" and len(args) == 2:
            g.remove_edge(args[0], args[1])
        elif cmd == "src" and len(args) == 1:
            g.set_source(args[0])
        elif cmd == "dist" and len(args) == 1:
            d = g.distance(args[0])
            print("INF" if d == INF else d, file=out)
        elif cmd == "path" and len(args) == 1:
            print(" ".join(g.path(args[0])), file=out)
        elif cmd == "recomputed" and not args:
            print(g.last_recomputed, file=out)
        else:
            return _fail(f"line {lineno}: invalid command: {raw.strip()!r}")
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) > 1:
        return _fail("usage: python -m incsp [script_file]")
    if argv:
        try:
            with open(argv[0], "r", encoding="utf-8") as fh:
                return run(fh, sys.stdout)
        except OSError as exc:
            return _fail(str(exc))
    return run(sys.stdin, sys.stdout)
