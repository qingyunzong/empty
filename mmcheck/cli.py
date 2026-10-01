"""Command line interface: load / check / patch.

Exit codes:
    0  success, no diagnostics
    1  success, diagnostics present
    2  usage or state error
    3  import cycle detected (load/patch fail atomically)
"""
from __future__ import annotations

import argparse
import os
import sys

from .project import (
    CycleError,
    ProjectError,
    full_check,
    load_state,
    patch_module,
    save_state,
)

EXIT_OK = 0
EXIT_DIAGNOSTICS = 1
EXIT_USAGE = 2
EXIT_CYCLE = 3


def _print_diagnostics(state) -> int:
    diags = state.all_diagnostics()
    if not diags:
        print("OK: no diagnostics")
        return EXIT_OK
    for d in diags:
        print(f"#{d['id']} {d['file']}:{d['line']}: {d['code']}: {d['message']}")
    print(f"{len(diags)} diagnostic(s)")
    return EXIT_DIAGNOSTICS


def _cmd_load(args) -> int:
    try:
        state = full_check(args.directory)
    except CycleError as exc:
        print(f"error: import cycle detected: {' -> '.join(exc.cycle)}", file=sys.stderr)
        return EXIT_CYCLE
    except ProjectError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    save_state(state, os.getcwd())
    print(f"loaded {len(state.modules)} module(s) from {state.directory}")
    return _print_diagnostics(state)


def _cmd_check(args) -> int:
    try:
        state = load_state(os.getcwd())
        state = full_check(state.directory)
    except CycleError as exc:
        print(f"error: import cycle detected: {' -> '.join(exc.cycle)}", file=sys.stderr)
        return EXIT_CYCLE
    except ProjectError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    save_state(state, os.getcwd())
    return _print_diagnostics(state)


def _cmd_patch(args) -> int:
    try:
        state = load_state(os.getcwd())
        affected = patch_module(state, args.file)
    except CycleError as exc:
        print(f"error: import cycle detected: {' -> '.join(exc.cycle)}", file=sys.stderr)
        return EXIT_CYCLE
    except ProjectError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    if affected is None:
        print(f"no-op: {args.file} unchanged (content identical)")
    else:
        save_state(state, os.getcwd())
        print(f"rechecked: {', '.join(sorted(affected))}")
    return _print_diagnostics(state)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="mmcheck",
        description="Mini module type checker",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_load = sub.add_parser("load", help="load and check all modules in a directory")
    p_load.add_argument("directory")
    p_load.set_defaults(func=_cmd_load)

    p_check = sub.add_parser("check", help="re-check every module of the loaded project")
    p_check.set_defaults(func=_cmd_check)

    p_patch = sub.add_parser("patch", help="re-check one changed file and its dependents")
    p_patch.add_argument("file")
    p_patch.set_defaults(func=_cmd_patch)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
