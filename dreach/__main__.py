import json
import sys

from .engine import UnknownSavepointError
from .operations import OperationFormatError, run_json


def main(argv=None):
    argv = sys.argv if argv is None else argv
    if len(argv) != 3 or argv[1] != "run":
        print("usage: python -m dreach run OPS.json", file=sys.stderr)
        return 2

    try:
        with open(argv[2], "r", encoding="utf-8") as source:
            results = run_json(source.read())
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OperationFormatError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except UnknownSavepointError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps({"results": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
