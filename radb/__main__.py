"""CLI: python -m radb query.json catalog.json tables_dir [output.json]"""
import json
import sys

from .engine import RadbError, run_query

USAGE = "usage: python -m radb query.json catalog.json tables_dir [output.json]"


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) not in (3, 4):
        print(json.dumps({"error": USAGE}))
        return 2
    try:
        result = run_query(args[0], args[1], args[2])
    except RadbError as exc:
        print(json.dumps({"error": str(exc)}))
        return 2
    text = json.dumps(result, indent=2)
    if len(args) == 4:
        with open(args[3], "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
