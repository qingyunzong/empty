"""JSON-lines CLI for the replicated-group simulator.

Reads one JSON command per line from stdin, writes one JSON response per
line to stdout. Any command error prints {"ok": false, "error": CODE} and
exits with status 6.

State is persisted under RGROUP_HOME (default ./.rgroup). Joint state and
unconfirmed writes are memory-only, so a process exit is a crash.

Commands:
  init    {"cmd":"init","nodes":["A","B","C"]}
  propose {"cmd":"propose","value":V}
  ack     {"cmd":"ack","id":N,"node":"A"}
  write   {"cmd":"write","value":V,"node":"A"}
  read    {"cmd":"read"}
  begin   {"cmd":"begin","old":[...],"new":[...]}
  commit  {"cmd":"commit" [,"failpoint":"before_config_fsync"]}
  abort   {"cmd":"abort"}
  crash   {"cmd":"crash"}     # drop memory, recover from disk
  status  {"cmd":"status"}
"""

from __future__ import annotations

import json
import os
import sys

from .core import Error, Group, NoGroup

EXIT_ERROR = 6


def _state_dir() -> str:
    return os.environ.get("RGROUP_HOME", ".rgroup")


def _handle(group: Group | None, cmd: dict, path: str) -> tuple[Group | None, dict]:
    op = cmd.get("cmd")

    if op == "init":
        group = Group(cmd["nodes"], path=path)
        group._persist()
        return group, {"ok": True, "epoch": group.config.epoch}

    if op == "crash":
        group = Group.load(path)  # recover last committed state from disk
        return group, {"ok": True, "recovered": True, "epoch": group.config.epoch}

    if group is None:
        raise NoGroup("no group initialized; send init first")

    if op == "propose":
        write = group.propose(cmd.get("value"))
        return group, {"ok": True, "id": write.id, "epoch": write.epoch, "committed": write.committed}
    if op == "ack":
        committed = group.ack(cmd["id"], cmd["node"])
        return group, {"ok": True, "committed": committed}
    if op == "write":
        write = group.write(cmd.get("value"), cmd["node"])
        return group, {"ok": True, "id": write.id, "committed": write.committed}
    if op == "read":
        return group, {"ok": True, "value": group.read(), "epoch": group.config.epoch}
    if op == "begin":
        group.begin_change(cmd["old"], cmd["new"])
        return group, {"ok": True, "joint": True, "epoch": group.config.epoch}
    if op == "commit":
        if "failpoint" in cmd:
            group.failpoint = cmd["failpoint"]
        config = group.commit_change()
        return group, {"ok": True, "epoch": config.epoch, "members": sorted(config.members)}
    if op == "abort":
        config = group.abort()
        return group, {"ok": True, "epoch": config.epoch, "members": sorted(config.members)}
    if op == "status":
        return group, {"ok": True, **group.status()}

    raise Error(f"unknown command {op!r}")


def main(argv: list[str] | None = None) -> int:
    path = _state_dir()
    group: Group | None = None
    if os.path.exists(os.path.join(path, "state.json")):
        group = Group.load(path)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"ok": False, "error": "BAD_JSON", "message": str(exc)}), flush=True)
            return EXIT_ERROR
        try:
            group, resp = _handle(group, cmd, path)
        except Error as exc:
            print(
                json.dumps({"ok": False, "error": exc.code, "message": str(exc)}),
                flush=True,
            )
            return EXIT_ERROR
        print(json.dumps(resp), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
