"""Check whether a timestamp-only change on a duplicate id counts as a conflict."""

import json
import os
import subprocess
import sys
import tempfile


def main():
    records = [
        {"id": "x", "key": "k", "ts": 10, "val": "v"},
        {"id": "x", "key": "k", "ts": 12, "val": "v"},
    ]
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "events.jsonl")
        with open(path, "w", encoding="utf-8") as stream:
            for record in records:
                stream.write(json.dumps(record) + "\n")
        result = subprocess.run(
            [sys.executable, "-m", "dedupwin", "--in", path,
             "--skew", "100", "--ret", "100"],
            capture_output=True, text=True, cwd=os.getcwd(), timeout=10,
        )

    if result.returncode != 0:
        print(f"CLI 退出码: {result.returncode}")
        return 2
    try:
        output = [json.loads(line) for line in result.stdout.splitlines()]
        stats = json.loads(result.stderr.strip())
    except json.JSONDecodeError:
        print("CLI 输出无法解析")
        return 2

    conflicts = stats.get("conflicts")
    duplicates = stats.get("duplicates")
    winner_ts = output[0].get("ts") if len(output) == 1 else None
    print(f"实际冲突计数: {conflicts}；预期: 1")
    print(f"实际重复计数: {duplicates}；输出条数: {len(output)}；胜者 ts: {winner_ts}")
    if conflicts == 0 and duplicates == 1 and winner_ts == 10:
        return 1
    if conflicts == 1 and duplicates == 1 and winner_ts == 10:
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
