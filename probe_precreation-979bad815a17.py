"""Check time travel before a key's first commit after garbage collection."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))

from vgc import MVCCStore, SnapshotExpired  # noqa: E402


def commit_value(store, txn, value):
    store.begin(txn)
    store.put(txn, "k", value)
    return store.commit(txn)


def main():
    store = MVCCStore(max_versions=1)
    first = commit_value(store, "first", "v1")
    commit_value(store, "second", "v2")
    report = store.gc()
    if report["reclaimed"] != 1:
        print(f"unexpected reclaimed count: {report['reclaimed']}")
        return 2

    # Confirm the first version really expired before checking an earlier time.
    try:
        store.as_of(first, "k")
    except SnapshotExpired:
        pass
    else:
        print("first committed version was not reclaimed")
        return 2

    before_creation = first - 1
    print(f"first_commit_ts={first} gc_reclaimed={report['reclaimed']}")
    try:
        actual = store.as_of(before_creation, "k")
    except SnapshotExpired as exc:
        print(f"as_of({before_creation},k): {type(exc).__name__}; {exc}")
        return 1

    print(f"as_of({before_creation},k): {actual!r}")
    if actual is not None:
        print("expected no value before the first commit")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
