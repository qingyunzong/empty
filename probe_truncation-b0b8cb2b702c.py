"""Reproduce the first-bad-chunk offset for a truncated data stream."""

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, os.getcwd())

from rchunk import core, index  # noqa: E402


def main() -> int:
    data = bytes(8192)
    spans = core.chunk_stream(data)
    if spans != [(0, 4096), (4096, 4096)]:
        raise AssertionError(f"unexpected zero-data chunks: {spans!r}")
    entries = index.entries_from_data(data, spans)
    index.verify(entries, data)
    first_bad_chunk = entries[1].offset

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        data_path = root / "truncated.bin"
        index_path = root / "original.chunk"
        data_path.write_bytes(data[:-1])
        index_path.write_bytes(index.dumps(entries))
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONPATH"] = os.getcwd()
        result = subprocess.run(
            [sys.executable, "-m", "rchunk", "verify", str(data_path), str(index_path)],
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
            check=False,
        )

    output = result.stderr.strip()
    match = re.fullmatch(r"CORRUPT \(offset (\d+)\): .+", output)
    if result.returncode != 1 or match is None:
        raise AssertionError(
            f"unexpected verify result: exit={result.returncode}, stderr={output!r}"
        )
    reported = int(match.group(1))
    if reported == first_bad_chunk:
        raise AssertionError("defect not reproduced: first bad chunk was reported")
    print(output)
    print(f"首个受损块起点: {first_bad_chunk}；程序报告: {reported}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
