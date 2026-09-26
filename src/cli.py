"""Command line interface: build / audit / plan / apply / demo."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import builder
from .audit import Auditor
from .repair import BaselineMismatchError, RepairError, apply_plan, build_plan
from .workspace import Workspace


def _cmd_build(args):
    ws = Workspace(args.root)
    version = builder.build(ws)
    print(f"built components at version {version} under {ws.data_dir}")
    return 0


def _cmd_audit(args):
    ws = Workspace(args.root)
    report = Auditor(ws).run()
    if args.json:
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(report.render_text())
    return 0 if report.ok else 1


def _cmd_plan(args):
    ws = Workspace(args.root)
    report = Auditor(ws).run()
    plan = build_plan(ws, report)
    out = Path(args.out) if args.out else ws.root / "repair_plan.json"
    out.write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"audit: {len(report.issues)} unique issue(s); "
        f"plan with {len(plan['ops'])} op(s) written to {out}"
    )
    if not plan["ops"]:
        print("nothing to repair")
    return 0


def _cmd_apply(args):
    ws = Workspace(args.root)
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    try:
        new_version = apply_plan(ws, plan)
    except BaselineMismatchError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    except RepairError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 3
    print(f"repair applied; components now at version {new_version}")
    return 0


def _cmd_demo(args):
    from .demo import run_demo

    run_demo(args.root)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="index-audit", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    commands = [
        ("build", _cmd_build, "build all components from data/docs/*.txt"),
        ("audit", _cmd_audit, "read-only consistency audit"),
        ("plan", _cmd_plan, "audit and write a repair plan bound to the baseline"),
        ("apply", _cmd_apply, "validate the baseline and apply a repair plan"),
        ("demo", _cmd_demo, "end-to-end demo with synthetic UTF-8 documents"),
    ]
    for name, func, help_text in commands:
        sub_parser = sub.add_parser(name, help=help_text)
        sub_parser.add_argument("--root", default="demo_workspace")
        if name == "audit":
            sub_parser.add_argument("--json", action="store_true")
        if name == "plan":
            sub_parser.add_argument("--out")
        if name == "apply":
            sub_parser.add_argument("--plan", required=True)
        sub_parser.set_defaults(func=func)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
