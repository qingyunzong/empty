"""Command line interface: generate / corrupt / audit / fixplan."""
from __future__ import annotations

import argparse
import sys

from .auditor import audit
from .corrupt import corrupt
from .fixplan import build_plan, validate_plan
from .generator import generate


def _cmd_generate(args) -> int:
    ds = generate(args.out, num_docs=args.docs, seed=args.seed)
    print(f"generated {ds.stats['num_docs']} docs, {ds.stats['num_terms']} terms, "
          f"{ds.stats['total_tokens']} tokens under {args.out}")
    return 0


def _cmd_corrupt(args) -> int:
    actions = corrupt(args.data, seed=args.seed)
    print(f"injected {len(actions)} corruption(s) into {args.data}:")
    for action in actions:
        print(f"  - {action}")
    return 0


def _print_report(report) -> None:
    counts = report.counts_by_kind()
    print(f"audit found {len(report.issues)} issue(s) across {len(counts)} kind(s)")
    for kind, count in counts.items():
        print(f"  {kind}: {count}")
    for issue in report.issues:
        src = ",".join(issue.sources)
        print(f"  [{issue.kind}] {issue.subject} :: {issue.detail} (evidence: {src})")


def _cmd_audit(args) -> int:
    report = audit(args.data)
    _print_report(report)
    print("status: OK" if report.ok else "status: INCONSISTENT")
    return 0 if report.ok else 1


def _cmd_fixplan(args) -> int:
    plan, report = build_plan(args.data)
    print(f"audit found {len(report.issues)} issue(s); "
          f"fix plan has {len(plan)} operation(s):")
    for n, op in enumerate(plan, 1):
        print(f"  {n:2d}. {op}")
    result = validate_plan(args.data, plan)
    print(f"baseline validation: applied {result.applied_ops} op(s) on a scratch "
          f"copy; residual issues: {len(result.residual_issues)}; "
          f"unexpected changes vs baseline: {len(result.unexpected_changes)}")
    for issue in result.residual_issues:
        print(f"  residual [{issue.kind}] {issue.subject} :: {issue.detail}")
    for change in result.unexpected_changes:
        print(f"  unexpected: {change}")
    print("validation: PASS (baseline untouched, plan verified)"
          if result.ok else "validation: FAIL")
    return 0 if result.ok else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="search_audit", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("generate", help="build a synthetic UTF-8 dataset")
    p.add_argument("--out", required=True)
    p.add_argument("--docs", type=int, default=40)
    p.add_argument("--seed", type=int, default=7)
    p.set_defaults(func=_cmd_generate)

    p = sub.add_parser("corrupt", help="inject controlled inconsistencies")
    p.add_argument("--data", required=True)
    p.add_argument("--seed", type=int, default=99)
    p.set_defaults(func=_cmd_corrupt)

    p = sub.add_parser("audit", help="read-only consistency audit")
    p.add_argument("--data", required=True)
    p.set_defaults(func=_cmd_audit)

    p = sub.add_parser("fixplan",
                       help="build a fix plan and validate it against the baseline")
    p.add_argument("--data", required=True)
    p.set_defaults(func=_cmd_fixplan)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
