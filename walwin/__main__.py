"""CLI: python -m walwin --in e.jsonl --dir state --win 60000

Reads JSONL records {seq, key, ts, delta}, applies them with WAL
durability semantics, snapshots the state, and prints the final
per-key window sums as JSON lines to stdout.

Exit codes: 0 success; 3 state directory not writable.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import (
    WAL_NAME,
    State,
    encode_commit,
    encode_data,
    maybe_fault,
    recover,
    write_snapshot,
)


def _parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="walwin",
        description="WAL-backed sliding-window sum processor.",
    )
    parser.add_argument("--in", dest="input", required=True,
                        help="input JSONL file of {seq,key,ts,delta} records")
    parser.add_argument("--dir", dest="dir", required=True,
                        help="state directory holding wal.log and snapshot.json")
    parser.add_argument("--win", dest="win", type=int, required=True,
                        help="window length in milliseconds")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(argv)

    try:
        os.makedirs(args.dir, exist_ok=True)
        wal_path = os.path.join(args.dir, WAL_NAME)
        wal = open(wal_path, "a", encoding="utf-8")
    except OSError:
        print(f"walwin: state directory not writable: {args.dir}",
              file=sys.stderr)
        return 3

    try:
        state: State = recover(args.dir)
        with open(args.input, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                seq = rec["seq"]
                if seq in state.committed:
                    continue  # duplicate seq: idempotent skip
                wal.write(encode_data(rec) + "\n")
                maybe_fault("P1")  # WAL appended, not yet fsynced
                wal.flush()
                os.fsync(wal.fileno())
                maybe_fault("P2")  # fsynced, commit entry not yet written
                wal.write(encode_commit(seq) + "\n")
                wal.flush()
                os.fsync(wal.fileno())
                state.apply(seq, rec["key"], rec["ts"], rec["delta"])
        wal.close()
        write_snapshot(args.dir, state)
    except OSError:
        print(f"walwin: state directory not writable: {args.dir}",
              file=sys.stderr)
        return 3

    maybe_fault("P4")  # state durable, output not yet written

    for key, info in sorted(state.window_sums(args.win).items()):
        print(json.dumps({"key": key, **info}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
