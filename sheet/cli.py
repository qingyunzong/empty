"""Command-line interface for the incremental spreadsheet.

Usage:
    python -m sheet [script_file]

Commands (one per line, read from the file or stdin):
    set <cell> <expr>   set a cell to an expression (optional '=' allowed)
    del <cell>          delete a cell (equivalent to setting it to 0)
    get <cell>          print the cell's current value
    dump                print all cells, sorted by name, as "NAME = VALUE"

Exit codes: 0 ok, 2 parse/usage error, 3 reference cycle.
"""

import sys

from .engine import CycleError, Sheet
from .parser import CELL_RE, ParseError, parse


def _cell_arg(parts):
    if len(parts) < 2:
        raise ParseError("missing cell argument")
    cell = parts[1].upper()
    if not CELL_RE.match(cell):
        raise ParseError("invalid cell name: %r" % (parts[1],))
    return cell


def run_line(sheet, line):
    """Execute one command line. Returns output text (possibly empty)."""
    parts = line.split(None, 2)
    command = parts[0].lower()
    if command == "set":
        if len(parts) < 3:
            raise ParseError("usage: set <cell> <expr>")
        cell = _cell_arg(parts)
        text = parts[2]
        if text.startswith("="):
            text = text[1:].strip()
        sheet.set(cell, parse(text))
        return ""
    if command == "del":
        sheet.delete(_cell_arg(parts))
        return ""
    if command == "get":
        return "%s\n" % (sheet.get(_cell_arg(parts)),)
    if command == "dump":
        return "".join("%s = %s\n" % (name, value) for name, value in sheet.dump())
    raise ParseError("unknown command: %r" % (parts[0],))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) > 1:
        print("error: usage: python -m sheet [script_file]", file=sys.stderr)
        return 2
    if argv:
        try:
            with open(argv[0], "r", encoding="utf-8") as handle:
                lines = handle.read().splitlines()
        except OSError as exc:
            print("error: %s" % (exc,), file=sys.stderr)
            return 2
    else:
        lines = sys.stdin.read().splitlines()

    sheet = Sheet()
    sheet.warn = lambda message: print("warning: %s" % message, file=sys.stderr)
    for lineno, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            output = run_line(sheet, line)
        except ParseError as exc:
            print("error: line %d: %s" % (lineno, exc), file=sys.stderr)
            return 2
        except CycleError as exc:
            print("error: line %d: %s" % (lineno, exc), file=sys.stderr)
            return 3
        if output:
            sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
