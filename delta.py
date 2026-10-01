#!/usr/bin/env python3
"""Usage: delta.py source.bin target.bin patch.json"""

import json
import sys

from dpcore import make_patch


def main(argv):
    if len(argv) != 4:
        print("usage: delta.py source.bin target.bin patch.json", file=sys.stderr)
        return 2
    source_path, target_path, patch_path = argv[1:4]
    try:
        with open(source_path, "rb") as fh:
            source = fh.read()
        with open(target_path, "rb") as fh:
            target = fh.read()
    except OSError as exc:
        print("delta: %s" % exc, file=sys.stderr)
        return 2
    patch = make_patch(source, target)
    try:
        with open(patch_path, "w", encoding="utf-8") as fh:
            json.dump(patch, fh, indent=2)
            fh.write("\n")
    except OSError as exc:
        print("delta: %s" % exc, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
