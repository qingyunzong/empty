#!/usr/bin/env python3
"""Usage: patch.py source.bin patch.json out.bin

Exit code 0 on success; 2 on any validation failure (output removed).
"""

import json
import os
import sys

from dpcore import PatchError, apply_patch


def main(argv):
    if len(argv) != 4:
        print("usage: patch.py source.bin patch.json out.bin", file=sys.stderr)
        return 2
    source_path, patch_path, out_path = argv[1:4]
    try:
        with open(source_path, "rb") as fh:
            source = fh.read()
        with open(patch_path, "r", encoding="utf-8") as fh:
            patch = json.load(fh)
        result = apply_patch(source, patch)
    except (OSError, ValueError, PatchError) as exc:
        print("patch: %s" % exc, file=sys.stderr)
        try:
            os.remove(out_path)
        except OSError:
            pass
        return 2
    try:
        with open(out_path, "wb") as fh:
            fh.write(result)
    except OSError as exc:
        print("patch: %s" % exc, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
