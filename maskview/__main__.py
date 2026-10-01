"""CLI: python -m maskview query data.json policy.json role

Prints the masked rows as a JSON array on stdout.  Any PolicyError is
reported as a JSON object on stderr and exits with status 2.
"""

from __future__ import annotations

import json
import sys

from .engine import run_query
from .errors import PolicyError

USAGE = "usage: python -m maskview query <data.json> <policy.json> <role>"


def _load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise PolicyError("E_IO", "file not found: %s" % path) from exc
    except json.JSONDecodeError as exc:
        raise PolicyError("E_DATA", "invalid JSON in %s: %s" % (path, exc)) from exc
    except OSError as exc:
        raise PolicyError("E_IO", "cannot read %s: %s" % (path, exc)) from exc


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) != 4 or argv[0] != "query":
            raise PolicyError("E_USAGE", USAGE)
        _, data_path, policy_path, role = argv
        result = run_query(_load_json(data_path), _load_json(policy_path), role)
    except PolicyError as exc:
        json.dump({"error": exc.code, "message": exc.message}, sys.stderr, ensure_ascii=False)
        sys.stderr.write("\n")
        return 2
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
