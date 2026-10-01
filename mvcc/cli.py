"""Line-delimited JSON CLI for the MVCC store.

Reads one JSON command per line from stdin, writes one JSON result per line
to stdout. Errors are reported as {"error": <code>} and processing continues.

Commands:
  {"op": "begin",  "mode": "snapshot"|"read_committed", "txn": <id, optional>}
  {"op": "get",    "txn": <id>, "key": <str>}
  {"op": "put",    "txn": <id>, "key": <str>, "value": <any JSON>}
  {"op": "delete", "txn": <id>, "key": <str>}
  {"op": "commit", "txn": <id>}
  {"op": "abort",  "txn": <id>}
"""

from __future__ import annotations

import json
import sys
from typing import Any, Dict, TextIO

from .store import MVCCStore, MVCError


def handle_command(store: MVCCStore, command: Dict[str, Any]) -> Dict[str, Any]:
    op = command.get("op")
    if op == "begin":
        txn_id = store.begin(mode=command.get("mode"), txn_id=command.get("txn"))
        return {"ok": True, "txn": txn_id}
    if op == "get":
        return {"value": store.get(command["txn"], command["key"])}
    if op == "put":
        store.put(command["txn"], command["key"], command.get("value"))
        return {"ok": True}
    if op == "delete":
        store.delete(command["txn"], command["key"])
        return {"ok": True}
    if op == "commit":
        commit_ts = store.commit(command["txn"])
        return {"ok": True, "commit_ts": commit_ts}
    if op == "abort":
        store.abort(command["txn"])
        return {"ok": True}
    return {"error": "UNKNOWN_OP"}


def run(stdin: TextIO, stdout: TextIO) -> None:
    store = MVCCStore()
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError("command must be a JSON object")
            result = handle_command(store, command)
        except MVCError as exc:
            result = {"error": exc.code}
        except (json.JSONDecodeError, ValueError):
            result = {"error": "BAD_COMMAND"}
        except (KeyError, TypeError):
            result = {"error": "BAD_COMMAND"}
        stdout.write(json.dumps(result) + "\n")
        stdout.flush()


def main() -> None:
    run(sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
