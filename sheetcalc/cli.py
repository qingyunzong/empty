"""Command-line interface for the incremental spreadsheet evaluator.

Commands (read from stdin, one per line; blank lines and '#' comments
are ignored):
    set <cell> <expr>   define/redefine a cell expression
    del <cell>          delete a cell (equivalent to setting it to 0)
    get <cell>          print the current value of a cell
    dump                print all live cells sorted by name
    quit                exit successfully

Exit codes: 0 ok, 2 parse/usage error, 3 dependency cycle.
Warnings (e.g. undefined references) go to stderr.
"""

import sys

from .engine import Sheet
from .parser import E_DIV0, ParseError
from .engine import CycleError

EXIT_OK = 0
EXIT_PARSE = 2
EXIT_CYCLE = 3


def _format_value(value):
    return E_DIV0 if value == E_DIV0 else str(value)


def run(sheet, instream, out, err):
    for raw in instream:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 2)
        cmd = parts[0].lower()
        try:
            if cmd == "set":
                if len(parts) < 3:
                    raise ParseError("usage: set <cell> <expr>")
                sheet.set(parts[1], parts[2])
            elif cmd == "del":
                if len(parts) != 2:
                    raise ParseError("usage: del <cell>")
                sheet.delete(parts[1])
            elif cmd == "get":
                if len(parts) != 2:
                    raise ParseError("usage: get <cell>")
                out.write("%s\n" % _format_value(sheet.get(parts[1])))
            elif cmd == "dump":
                if len(parts) != 1:
                    raise ParseError("usage: dump")
                for name, src, value, version in sheet.dump():
                    out.write(
                        "%s = %s => %s (v%d)\n"
                        % (name, src, _format_value(value), version)
                    )
            elif cmd in ("quit", "exit"):
                break
            else:
                raise ParseError("unknown command %r" % parts[0])
        except ParseError as exc:
            err.write("error: %s\n" % exc)
            return EXIT_PARSE
        except CycleError as exc:
            err.write("error: %s\n" % exc)
            return EXIT_CYCLE
        for warning in sheet.warnings:
            err.write("warning: %s\n" % warning)
    return EXIT_OK


def main(argv=None):
    sheet = Sheet()
    return run(sheet, sys.stdin, sys.stdout, sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
