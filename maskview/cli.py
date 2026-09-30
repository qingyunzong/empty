"""Command line interface for maskview.

Usage:
    python -m maskview query data.json policy.json ROLE [--sort-by COL] [--desc]
    python -m maskview count data.json policy.json ROLE

``query`` prints the visible, masked rows as a JSON array on stdout.
``count`` prints ``{"count": N}`` -- the only interface that reveals how
many rows are visible.  All errors are reported as PolicyError JSON on
stderr with exit code 2.
"""
from __future__ import annotations

import argparse
import json
import sys

from .engine import MaskView
from .errors import PolicyError

EXIT_OK = 0
EXIT_POLICY_ERROR = 2


def _load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise PolicyError("E_INPUT", f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise PolicyError("E_INPUT", f"invalid JSON in {path}: {exc}") from exc
    except OSError as exc:
        raise PolicyError("E_INPUT", f"cannot read {path}: {exc}") from exc


def _build_parser():
    parser = argparse.ArgumentParser(prog="maskview")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("query", "count"):
        sub = subparsers.add_parser(name)
        sub.add_argument("data", help="path to data JSON file")
        sub.add_argument("policy", help="path to policy JSON file")
        sub.add_argument("role", help="role to evaluate as")
        if name == "query":
            sub.add_argument("--sort-by", default=None, help="column to sort output by")
            sub.add_argument("--desc", action="store_true", help="sort descending")
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        data = _load_json(args.data)
        policy = _load_json(args.policy)
        view = MaskView(data, policy)
        if args.command == "query":
            result = view.query(args.role, sort_by=args.sort_by, descending=args.desc)
        else:
            result = {"count": view.count(args.role)}
    except PolicyError as exc:
        json.dump({"error": {"code": exc.code, "message": exc.message}}, sys.stderr)
        sys.stderr.write("\n")
        return EXIT_POLICY_ERROR
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return EXIT_OK
