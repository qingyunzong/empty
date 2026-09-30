"""Command line interface: python -m tenantq <command> ...

State is persisted as JSON in a state file (default ./tenantq-state.json,
override with --db or the TENANTQ_DB environment variable).  Every command
prints a JSON status object to stdout.  PolicyError failures print a JSON
error object to stderr and exit with code 2.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

from .core import E_STATE, Engine, PolicyError

DEFAULT_DB = "tenantq-state.json"


def _db_path(args):
    return args.db or os.environ.get("TENANTQ_DB") or DEFAULT_DB


def _load(path):
    if not os.path.exists(path):
        return Engine()
    with open(path, "r", encoding="utf-8") as fh:
        return Engine.from_dict(json.load(fh))


def _save(engine, path):
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tenantq-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(engine.to_dict(), fh, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _cmd_init(args):
    path = _db_path(args)
    if os.path.exists(path):
        raise PolicyError(E_STATE, f"state file {path!r} already exists")
    engine = Engine()
    _save(engine, path)
    return {"ok": True, "initialized": path}


def _cmd_tenant_add(args):
    return _mutate(args, lambda e: e.add_tenant(args.tenant_id, parent=args.parent))


def _cmd_quota_set(args):
    return _mutate(args, lambda e: e.set_quota(args.tenant_id, args.resource, args.limit))


def _cmd_reserve(args):
    return _mutate(
        args, lambda e: e.reserve(args.tenant_id, args.resource, args.amount, args.key)
    )


def _cmd_confirm(args):
    return _mutate(args, lambda e: e.confirm(args.reservation_id))


def _cmd_release(args):
    return _mutate(args, lambda e: e.release(args.reservation_id))


def _mutate(args, fn):
    """Run fn(engine) and persist state even when fn raises PolicyError.

    Failed reserves record a "failed" reservation for audit (pending is
    rolled back first), so the state must be saved on the error path too.
    """
    path = _db_path(args)
    engine = _load(path)
    try:
        return fn(engine)
    finally:
        _save(engine, path)

def _cmd_status(args):
    engine = _load(_db_path(args))
    return engine.status(tenant_id=args.tenant)


def _cmd_reservation(args):
    engine = _load(_db_path(args))
    return engine.reservation(args.reservation_id)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="tenantq",
        description="Hierarchical tenant quota reservations.",
    )
    parser.add_argument(
        "--db",
        default=None,
        help="state file path (default: $TENANTQ_DB or ./tenantq-state.json)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="create a fresh state file").set_defaults(
        func=_cmd_init
    )

    tenant = sub.add_parser("tenant", help="manage tenants")
    tenant_sub = tenant.add_subparsers(dest="tenant_command", required=True)
    tenant_add = tenant_sub.add_parser("add", help="add a tenant")
    tenant_add.add_argument("tenant_id")
    tenant_add.add_argument("--parent", default=None)
    tenant_add.set_defaults(func=_cmd_tenant_add)

    quota = sub.add_parser("quota", help="manage quotas")
    quota_sub = quota.add_subparsers(dest="quota_command", required=True)
    quota_set = quota_sub.add_parser("set", help="set a quota limit")
    quota_set.add_argument("tenant_id")
    quota_set.add_argument("resource")
    quota_set.add_argument("limit", type=int)
    quota_set.set_defaults(func=_cmd_quota_set)

    reserve = sub.add_parser("reserve", help="reserve quota along the tenant chain")
    reserve.add_argument("tenant_id")
    reserve.add_argument("resource")
    reserve.add_argument("amount", type=int)
    reserve.add_argument("--key", required=True, help="idempotency key")
    reserve.set_defaults(func=_cmd_reserve)

    confirm = sub.add_parser("confirm", help="confirm a pending reservation")
    confirm.add_argument("reservation_id")
    confirm.set_defaults(func=_cmd_confirm)

    release = sub.add_parser("release", help="release a confirmed reservation")
    release.add_argument("reservation_id")
    release.set_defaults(func=_cmd_release)

    status = sub.add_parser("status", help="show tenant quota status")
    status.add_argument("--tenant", default=None)
    status.set_defaults(func=_cmd_status)

    rsv = sub.add_parser("reservation", help="show a reservation")
    rsv.add_argument("reservation_id")
    rsv.set_defaults(func=_cmd_reservation)

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        result = args.func(args)
    except PolicyError as exc:
        print(json.dumps(exc.to_dict(), indent=2), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0
