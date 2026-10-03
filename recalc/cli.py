"""Command line interface for the incremental recompute planner.

Reads commands from a script file (first argument) or from stdin:

    set <id> <cost> <value> [dep1,dep2,...]   define/redefine a node
    upd <id> <cost>                           update cost, mark dirty
    run <budget>                              pick + apply optimal plan
    best <budget>                             print optimal plan only
    status                                    print dirty node ids

Exit codes: 0 ok, 1 usage/IO error, 2 negative cost/budget,
3 dependency cycle, 4 unknown node.
"""

import sys

from .core import RecalcError, RecalcGraph


class UsageError(RecalcError):
    exit_code = 1


def _parse_int(token, what):
    try:
        return int(token)
    except ValueError:
        raise UsageError(f"invalid {what}: {token!r}") from None


def _execute(graph, line, out):
    parts = line.split()
    cmd, args = parts[0], parts[1:]
    if cmd == "set":
        if len(args) not in (3, 4):
            raise UsageError("usage: set <id> <cost> <value> [dep1,dep2,...]")
        cost = _parse_int(args[1], "cost")
        value = _parse_int(args[2], "value")
        deps = ()
        if len(args) == 4 and args[3] != "-":
            deps = tuple(d for d in args[3].split(",") if d)
        graph.set_node(args[0], cost, value, deps)
    elif cmd == "upd":
        if len(args) != 2:
            raise UsageError("usage: upd <id> <cost>")
        graph.update_cost(args[0], _parse_int(args[1], "cost"))
    elif cmd in ("run", "best"):
        if len(args) != 1:
            raise UsageError(f"usage: {cmd} <budget>")
        budget = _parse_int(args[0], "budget")
        plan = graph.run(budget) if cmd == "run" else graph.best(budget)
        ids = ",".join(plan.ids) if plan.ids else "-"
        print(f"selected: {ids} value: {plan.value} cost: {plan.cost}", file=out)
    elif cmd == "status":
        dirty = graph.dirty_ids()
        print(f"dirty: {','.join(dirty) if dirty else '-'}", file=out)
    else:
        raise UsageError(f"unknown command: {cmd!r}")


def main(argv=None, out=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    out = sys.stdout if out is None else out
    if len(argv) > 1:
        print("usage: python -m recalc [script-file]", file=sys.stderr)
        return 1
    graph = RecalcGraph()
    try:
        if argv:
            with open(argv[0], "r", encoding="utf-8") as handle:
                lines = handle.read().splitlines()
        else:
            lines = sys.stdin.read().splitlines()
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    for lineno, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            _execute(graph, line, out)
        except RecalcError as exc:
            print(f"error (line {lineno}): {exc}", file=sys.stderr)
            return exc.exit_code
    return 0
