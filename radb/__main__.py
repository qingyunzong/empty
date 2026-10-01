"""Command line interface: python -m radb query.json catalog.json tables_dir

On success: writes result.json to the current directory and prints a JSON
summary to stdout, exit code 0.
On any user-facing error: prints a JSON error object (and nothing else) to
stdout, produces no result file, exit code 2.
"""

import json
import sys

from .engine import RadbError, run

USAGE = "usage: python -m radb <query.json> <catalog.json> <tables_dir>"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 3:
        sys.stdout.write(json.dumps({"error": USAGE}) + "\n")
        return 2
    try:
        summary = run(argv[0], argv[1], argv[2])
    except RadbError as exc:
        sys.stdout.write(json.dumps({"error": str(exc)}) + "\n")
        return 2
    sys.stdout.write(json.dumps({
        "status": "ok",
        "join_order": summary["join_order"],
        "cost": str(summary["cost"]),
        "rows": summary["rows"],
    }) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
