"""CLI: python -m joinview state.json script.json

Runs the script against the committed state, persists on commit, and prints
the materialized view (per A: join-row count and sum of B) as JSON to stdout.

Exit codes: 0 success; 1 usage/IO/JSON errors; 2 script semantic error
(committed state left untouched).
"""

from __future__ import annotations

import json
import sys

from .core import SemanticError, compute_view, load_script, load_state, run_script, save_state


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2:
        print("usage: python -m joinview state.json script.json", file=sys.stderr)
        return 1
    state_path, script_path = argv

    try:
        state = load_state(state_path)
        script = load_script(script_path)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    try:
        engine = run_script(state, script)
    except SemanticError as error:
        print(f"semantic error: {error}", file=sys.stderr)
        return 2

    if engine.persisted:
        try:
            save_state(state_path, engine.committed)
        except OSError as error:
            print(f"error: {error}", file=sys.stderr)
            return 1

    json.dump(compute_view(engine.committed), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
