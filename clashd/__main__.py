"""CLI: python -m clashd decide rules.json req.json"""

import json
import sys

from .errors import PolicyError
from .policy import decide, load_policy


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        raise PolicyError("E_IO", f"cannot read {path}: {exc}") from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise PolicyError("E_INVALID_JSON", f"{path}: {exc}") from exc


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) != 3 or argv[0] != "decide":
            raise PolicyError(
                "E_USAGE", "usage: python -m clashd decide <rules.json> <req.json>"
            )
        policy = load_policy(_read_json(argv[1]))
        request = _read_json(argv[2])
        result = decide(policy, request)
    except PolicyError as exc:
        json.dump(
            {"error": {"code": exc.code, "message": exc.message}},
            sys.stderr,
            sort_keys=True,
        )
        sys.stderr.write("\n")
        return 2
    json.dump(result.to_dict(), sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
