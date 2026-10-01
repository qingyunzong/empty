"""JSON-lines CLI: seed / put / digest / reconcile / apply. Errors exit 5."""

import argparse
import json
import sys

from . import digest as digest_mod
from . import reconcile as reconcile_mod
from . import store

EXIT_ERROR = 5


def _emit(obj):
    print(json.dumps(obj, sort_keys=True))


def _parse_value(raw):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def cmd_seed(args):
    rep = store.seed(args.id, args.keys, args.seed)
    store.save(rep, args.replica)
    _emit({"ok": True, "replica": args.id, "keys": args.keys, "path": args.replica})


def cmd_put(args):
    rep = store.load(args.replica)
    entry = store.put(rep, args.key, _parse_value(args.value))
    store.save(rep, args.replica)
    _emit({"ok": True, "key": args.key, "vv": entry["vv"], "value": entry["value"]})


def cmd_digest(args):
    rep = store.load(args.replica)
    digests = digest_mod.replica_digests(rep)
    if args.bucket is not None:
        if not 0 <= args.bucket < digest_mod.NUM_BUCKETS:
            raise store.StoreError(
                f"bucket must be in [0, {digest_mod.NUM_BUCKETS - 1}]"
            )
        _emit({"bucket": args.bucket, "digest": digests[args.bucket]})
    else:
        for bk, dig in enumerate(digests):
            _emit({"bucket": bk, "digest": dig})


def cmd_reconcile(args):
    a = store.load(args.a)
    b = store.load(args.b)
    plan = reconcile_mod.build_plan(
        a, b, max_rounds=args.max_rounds,
        max_keys_per_round=args.max_keys_per_round,
    )
    if args.plan_out:
        try:
            with open(args.plan_out, "w", encoding="utf-8") as fh:
                json.dump(plan, fh, sort_keys=True)
                fh.write("\n")
        except OSError as exc:
            raise store.StoreError(f"cannot write plan {args.plan_out}: {exc}") from exc
    _emit(plan)


def cmd_apply(args):
    a = store.load(args.a)
    b = store.load(args.b)
    try:
        with open(args.plan, "r", encoding="utf-8") as fh:
            plan = json.load(fh)
    except OSError as exc:
        raise store.StoreError(f"cannot read plan {args.plan}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise store.StoreError(f"plan {args.plan} is not valid JSON: {exc}") from exc
    summary = reconcile_mod.apply_plan(a, b, plan)
    store.save(a, args.a)
    store.save(b, args.b)
    summary["ok"] = True
    _emit(summary)


def build_parser():
    parser = argparse.ArgumentParser(prog="kvae", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("seed", help="create a replica with random data")
    p.add_argument("--replica", required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--keys", type=int, default=0)
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(func=cmd_seed)

    p = sub.add_parser("put", help="write a key into a replica")
    p.add_argument("--replica", required=True)
    p.add_argument("--key", type=int, required=True)
    p.add_argument("--value", required=True)
    p.set_defaults(func=cmd_put)

    p = sub.add_parser("digest", help="print bucket digests of a replica")
    p.add_argument("--replica", required=True)
    p.add_argument("--bucket", type=int, default=None)
    p.set_defaults(func=cmd_digest)

    p = sub.add_parser("reconcile", help="build a reconciliation plan")
    p.add_argument("--a", required=True)
    p.add_argument("--b", required=True)
    p.add_argument("--max-rounds", type=int, default=reconcile_mod.DEFAULT_MAX_ROUNDS)
    p.add_argument("--max-keys-per-round", type=int,
                   default=reconcile_mod.DEFAULT_MAX_KEYS_PER_ROUND)
    p.add_argument("--plan-out", default=None)
    p.set_defaults(func=cmd_reconcile)

    p = sub.add_parser("apply", help="apply a plan to both replicas")
    p.add_argument("--a", required=True)
    p.add_argument("--b", required=True)
    p.add_argument("--plan", required=True)
    p.set_defaults(func=cmd_apply)

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except store.StoreError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return EXIT_ERROR
    return 0


if __name__ == "__main__":
    sys.exit(main())
