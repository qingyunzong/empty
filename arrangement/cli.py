"""JSON command-line interface for the arrangement library.

Usage:
    python3.11 -m arrangement.cli [commands.json]      (default: stdin)

Input: a JSON object {"commands": [...]} or a bare list of commands:
    {"op": "build",  "segments": [[[x, y], [x, y]], ...]}
    {"op": "add",    "segments": [...]}        -> {"added": [ids]}
    {"op": "remove", "ids": [id, ...]}
    {"op": "verify"}                           -> structural checks
    {"op": "dump"}                             -> full topology
    {"op": "stats"}
    {"op": "save",   "path": "file.json"}
    {"op": "load",   "path": "file.json"}

Coordinates are integers or exact rational strings like "3/2".
Floats are rejected: all computation is exact rational arithmetic.

Output: JSON list with one result object per command.  Exit status is
0 when every command succeeded, 1 otherwise.
"""

from __future__ import annotations

import json
import sys

from .arrangement import Arrangement


def _run(commands):
    arr = Arrangement()
    results = []
    ok_all = True
    for cmd in commands:
        try:
            op = cmd["op"]
            if op == "build":
                arr = Arrangement(cmd.get("segments", []))
                out = {"stats": arr.stats()}
            elif op == "add":
                out = {"added": arr.add_segments(cmd["segments"])}
            elif op == "remove":
                arr.remove_segments(cmd["ids"])
                out = {"removed": list(cmd["ids"])}
            elif op == "verify":
                out = {"checks": arr.verify()}
            elif op == "dump":
                out = {
                    "segments": arr.segments(),
                    "vertices": arr.vertices(),
                    "edges": arr.edges(),
                    "faces": arr.faces(),
                }
            elif op == "stats":
                out = {"stats": arr.stats()}
            elif op == "save":
                with open(cmd["path"], "w", encoding="utf-8") as fh:
                    json.dump(arr.to_dict(), fh, indent=1)
                out = {"saved": cmd["path"]}
            elif op == "load":
                with open(cmd["path"], encoding="utf-8") as fh:
                    arr = Arrangement.from_dict(json.load(fh))
                out = {"loaded": cmd["path"], "stats": arr.stats()}
            else:
                raise ValueError(f"unknown op: {op!r}")
            results.append({"ok": True, **out})
        except Exception as exc:  # report and continue with next command
            ok_all = False
            results.append({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return results, ok_all


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv:
        with open(argv[0], encoding="utf-8") as fh:
            payload = json.load(fh)
    else:
        payload = json.load(sys.stdin)
    commands = payload["commands"] if isinstance(payload, dict) else payload
    results, ok_all = _run(commands)
    json.dump(results, sys.stdout, indent=1)
    sys.stdout.write("\n")
    return 0 if ok_all else 1


if __name__ == "__main__":
    raise SystemExit(main())
