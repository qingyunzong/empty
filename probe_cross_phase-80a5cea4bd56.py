"""Check whether a pending old-epoch write can commit after begin_change."""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path.cwd()))

from rgroup import Group, StaleConfig  # noqa: E402


def main() -> int:
    group = Group(["a", "b", "c"])
    write = group.propose("old")
    pending_before_begin = not write.committed and group.read() is None
    old_epoch = write.epoch
    group.begin_change(["a", "b", "c"], ["c", "d", "e"])
    joint_epoch = group.config.epoch

    results = []
    try:
        for node in ("d", "e", "a", "c"):
            results.append(group.ack(write.id, node))
    except StaleConfig as exc:
        print(json.dumps({"accepted_after_begin": False, "error": exc.code}))
        return 1

    accepted = (
        pending_before_begin
        and old_epoch == joint_epoch
        and results == [False, False, False, True]
        and write.committed
        and group.read() == "old"
    )
    print(json.dumps({
        "old_epoch": old_epoch,
        "joint_epoch": joint_epoch,
        "ack_results": results,
        "committed": write.committed,
        "read": group.read(),
        "accepted_after_begin": accepted,
    }))
    return 0 if accepted else 1


if __name__ == "__main__":
    raise SystemExit(main())
