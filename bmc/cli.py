"""Command line interface: python -m bmc check model.json --bound N --out trace.json"""

import argparse
import json
import sys

from .checker import STATUS_ERROR, check
from .model import ModelError, load_model

EXIT_OK = 0
EXIT_RUNTIME_ERROR = 1
EXIT_BAD_MODEL = 2


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="bmc", description="Bounded model checker for integer systems"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    check_parser = subparsers.add_parser("check", help="run bounded model checking")
    check_parser.add_argument("model", help="path to the model JSON file")
    check_parser.add_argument(
        "--bound", type=int, default=10, help="maximum exploration depth"
    )
    check_parser.add_argument("--out", help="write the result JSON to this file")
    args = parser.parse_args(argv)

    if args.bound < 0:
        return _fail_model("bound must be non-negative")

    try:
        model = load_model(args.model)
    except ModelError as exc:
        return _fail_model(str(exc))

    result = check(model, args.bound)
    payload = json.dumps(result, indent=2, sort_keys=True)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
    print(payload)
    return EXIT_RUNTIME_ERROR if result["status"] == STATUS_ERROR else EXIT_OK


def _fail_model(message):
    line = json.dumps(
        {"status": "ERROR", "error": {"code": "E_MODEL", "message": message}}
    )
    print(line, file=sys.stderr)
    return EXIT_BAD_MODEL


if __name__ == "__main__":
    sys.exit(main())
