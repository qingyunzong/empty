"""Command line interface: load <dir> | check | patch <file>."""
import sys

from . import core

USAGE = "usage: python -m mtc load <dir> | check | patch <file>"


def main(argv=None):
    argv = list(sys.argv[1:]) if argv is None else argv
    if len(argv) == 2 and argv[0] == "load":
        return core.do_load(argv[1])
    if len(argv) == 1 and argv[0] == "check":
        return core.do_check()
    if len(argv) == 2 and argv[0] == "patch":
        return core.do_patch(argv[1])
    print(USAGE, file=sys.stderr)
    return 2
