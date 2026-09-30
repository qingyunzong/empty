"""CLI: python -m tenantq reserve|confirm|release|status --config C --state S ...

All output is JSON on stdout. Policy errors exit with code 2.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .core import E_CONFIG, Engine, PolicyError


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="tenantq", description="Hierarchical tenant quota reservations."
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", default="tenantq_config.json",
                        help="JSON file with quota config (flat path->quota map or {'quotas': {...}})")
    common.add_argument("--state", default="tenantq_state.json",
                        help="JSON file used to persist engine state between invocations")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("reserve", parents=[common], help="reserve quota along a tenant chain")
    p.add_argument("--tenant", required=True, help="tenant path, e.g. root/team/service")
    p.add_argument("--amount", required=True, type=int)
    p.add_argument("--key", required=True, help="idempotency key")

    p = sub.add_parser("confirm", parents=[common], help="confirm a pending reservation")
    p.add_argument("--key", help="idempotency key of the reservation")
    p.add_argument("--id", dest="reservation_id", help="reservation id")

    p = sub.add_parser("release", parents=[common], help="release used quota of a confirmed reservation")
    p.add_argument("--key", help="idempotency key of the reservation")
    p.add_argument("--id", dest="reservation_id", help="reservation id")
    p.add_argument("--amount", type=int, default=None,
                   help="partial release amount (default: remaining amount)")

    sub.add_parser("status", parents=[common], help="dump current engine state as JSON")
    return parser


def _load_quotas(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            config = json.load(fh)
    except FileNotFoundError:
        raise PolicyError(E_CONFIG, f"config file not found: {path}")
    except (OSError, json.JSONDecodeError) as exc:
        raise PolicyError(E_CONFIG, f"cannot read config file {path}: {exc}")
    if not isinstance(config, dict):
        raise PolicyError(E_CONFIG, "config must be a JSON object")
    quotas = config.get("quotas", config)
    if not isinstance(quotas, dict):
        raise PolicyError(E_CONFIG, "config 'quotas' must be a JSON object")
    return quotas


def _load_engine(args):
    quotas = _load_quotas(args.config)
    if os.path.exists(args.state):
        try:
            with open(args.state, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            raise PolicyError(E_CONFIG, f"cannot read state file {args.state}: {exc}")
        return Engine.from_dict(quotas, data)
    return Engine(quotas)


def _save_engine(args, engine):
    tmp = args.state + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(engine.to_dict(), fh, indent=2, sort_keys=True)
    os.replace(tmp, args.state)


def main(argv=None):
    args = _build_parser().parse_args(argv)
    engine = None
    try:
        engine = _load_engine(args)
        if args.command == "reserve":
            out = engine.reserve(args.tenant, args.amount, args.key)
        elif args.command == "confirm":
            out = engine.confirm(key=args.key, reservation_id=args.reservation_id)
        elif args.command == "release":
            out = engine.release(key=args.key, reservation_id=args.reservation_id,
                                 amount=args.amount)
        else:  # status
            out = {"status": "ok", "quotas": engine.quotas, **engine.snapshot()}
        code = 0
    except PolicyError as exc:
        out = {"status": "error", "error": exc.to_dict()}
        code = 2
    if args.command != "status" and engine is not None:
        try:
            _save_engine(args, engine)
        except OSError as exc:
            out = {"status": "error",
                   "error": {"code": E_CONFIG, "message": f"cannot write state: {exc}"}}
            code = 2
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
