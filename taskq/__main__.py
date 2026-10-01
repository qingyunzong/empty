import argparse
import json
import sys

from . import CrashExit, TaskqError, recover_db, run_script


def emit(obj):
    print(json.dumps(obj, sort_keys=True))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="taskq")
    sub = parser.add_subparsers(dest="command", required=True)
    p_run = sub.add_parser("run", help="execute a script of actions")
    p_run.add_argument("script")
    p_run.add_argument("--db", required=True)
    p_run.add_argument("--out", default=None)
    p_rec = sub.add_parser("recover", help="recover the db after a crash")
    p_rec.add_argument("--db", required=True)
    args = parser.parse_args(argv)

    try:
        if args.command == "run":
            run_script(args.script, args.db, args.out, emit=emit)
        else:
            recover_db(args.db, emit=emit)
    except TaskqError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except CrashExit as exc:
        print(json.dumps({"type": "crash", "stage": exc.stage}), file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
