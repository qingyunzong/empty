#!/usr/bin/env python3
"""Anti-entropy KV CLI. JSON-lines in/out. Errors exit with code 5.

Commands:
  seed PATH --replica R [--keys N --seed S]
  put PATH --replica R --key K --value V
  digest PATH [--bucket B]
  reconcile A B [--max-rounds N] [--max-keys-per-round M]
  apply A B PLAN_FILE   (PLAN_FILE may be "-" for stdin)
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys

import kvstore

EXIT_ERROR = 5


def emit(obj) -> None:
    print(json.dumps(obj, sort_keys=True))


def load_store(path: str) -> dict:
    if not os.path.exists(path):
        raise kvstore.KVError(f"store not found: {path}")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            store = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise kvstore.KVError(f"cannot load store {path}: {exc}")
    for field in ("replica", "data", "conflicts"):
        if field not in store:
            raise kvstore.KVError(f"store {path} missing field {field!r}")
    return store


def save_store(path: str, store: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(store, fh, sort_keys=True)
    os.replace(tmp, path)


def cmd_seed(args) -> None:
    if os.path.exists(path := args.path) and not args.force:
        raise kvstore.KVError(f"store already exists: {path} (use --force)")
    store = kvstore.empty_store(args.replica)
    if args.keys:
        if not 0 <= args.keys <= kvstore.KEY_SPACE:
            raise kvstore.KVError("--keys must be within [0, 256]")
        rng = random.Random(args.seed)
        for key in rng.sample(range(kvstore.KEY_SPACE), args.keys):
            kvstore.put(store, args.replica, key, f"v{key}")
    save_store(path, store)
    emit({"ok": True, "path": path, "replica": args.replica,
          "keys": len(store["data"])})


def cmd_put(args) -> None:
    store = load_store(args.path)
    key = kvstore.validate_key(args.key)
    entry = kvstore.put(store, args.replica, key, args.value)
    save_store(args.path, store)
    emit({"ok": True, "key": key, "value": entry["value"],
          "version": entry["version"]})


def cmd_digest(args) -> None:
    store = load_store(args.path)
    if args.bucket is not None:
        if not 0 <= args.bucket < kvstore.NUM_BUCKETS:
            raise kvstore.KVError(
                f"bucket must be in [0, {kvstore.NUM_BUCKETS - 1}]")
        emit({"bucket": args.bucket,
              **kvstore.bucket_summary(store, args.bucket)})
    else:
        for bucket in range(kvstore.NUM_BUCKETS):
            emit({"bucket": bucket, **kvstore.bucket_summary(store, bucket)})


def cmd_reconcile(args) -> None:
    a = load_store(args.a)
    b = load_store(args.b)
    plan = kvstore.reconcile(a, b, max_rounds=args.max_rounds,
                             max_keys_per_round=args.max_keys_per_round)
    emit(plan)


def cmd_apply(args) -> None:
    a = load_store(args.a)
    b = load_store(args.b)
    try:
        if args.plan == "-":
            plan = json.loads(sys.stdin.read())
        else:
            with open(args.plan, "r", encoding="utf-8") as fh:
                plan = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise kvstore.KVError(f"cannot load plan: {exc}")
    if not isinstance(plan, dict) or "status" not in plan:
        raise kvstore.KVError("invalid plan")
    result = kvstore.apply_plan(plan, a, b)
    save_store(args.a, a)
    save_store(args.b, b)
    emit({"ok": True, **result})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="kv", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("seed")
    p.add_argument("path")
    p.add_argument("--replica", required=True)
    p.add_argument("--keys", type=int, default=0)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_seed)

    p = sub.add_parser("put")
    p.add_argument("path")
    p.add_argument("--replica", required=True)
    p.add_argument("--key", type=int, required=True)
    p.add_argument("--value", required=True)
    p.set_defaults(func=cmd_put)

    p = sub.add_parser("digest")
    p.add_argument("path")
    p.add_argument("--bucket", type=int, default=None)
    p.set_defaults(func=cmd_digest)

    p = sub.add_parser("reconcile")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--max-rounds", type=int,
                   default=kvstore.DEFAULT_MAX_ROUNDS)
    p.add_argument("--max-keys-per-round", type=int,
                   default=kvstore.DEFAULT_MAX_KEYS_PER_ROUND)
    p.set_defaults(func=cmd_reconcile)

    p = sub.add_parser("apply")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("plan")
    p.set_defaults(func=cmd_apply)

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except kvstore.KVError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return EXIT_ERROR
    return 0


if __name__ == "__main__":
    sys.exit(main())
