"""Independent, bounded checks of two rchunk behaviors."""

import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True


def malformed_index():
    data = bytes(8192)
    with tempfile.TemporaryDirectory() as temp:
        data_path = Path(temp) / "data.bin"
        index_path = Path(temp) / "data.chunk"
        data_path.write_bytes(data)
        index_path.write_text("{invalid json\n", encoding="utf-8")
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run(
            [sys.executable, "-m", "rchunk", "verify", str(data_path), str(index_path)],
            cwd=os.getcwd(), env=env, text=True, capture_output=True, timeout=10,
        )
    unhandled = (result.returncode == 1
                 and "Traceback (most recent call last):" in result.stderr
                 and "json.decoder.JSONDecodeError:" in result.stderr
                 and "Corrupt:" not in result.stderr)
    print(f"verify_exit={result.returncode}")
    print("cli_error=" + (result.stderr.splitlines()[-1] if result.stderr else "<none>"))
    if not unhandled:
        print("malformed JSON behavior did not reproduce", file=sys.stderr)
        return 1
    return 0


def truncated_block():
    sys.path.insert(0, os.getcwd())
    from rchunk import build_index, verify_index, CorruptError

    data = bytes(8192)
    index = build_index(data)
    entries = index["chunks"]
    if len(entries) != 2 or [entry["len"] for entry in entries] != [4096, 4096]:
        print("two 4096-byte blocks did not reproduce", file=sys.stderr)
        return 1
    first_bad = entries[1]["offset"]
    try:
        verify_index(data[:-1], index)
    except CorruptError as exc:
        print(f"first_bad_block={first_bad} reported_offset={exc.offset}")
        if exc.offset == len(data) - 1 and exc.offset != first_bad:
            return 0
        print("wrong-offset behavior did not reproduce", file=sys.stderr)
        return 1
    print("truncated data was accepted", file=sys.stderr)
    return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("case", choices=("malformed", "truncated"))
    args = parser.parse_args()
    raise SystemExit(malformed_index() if args.case == "malformed" else truncated_block())
