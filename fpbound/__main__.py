"""CLI: read a JSON expression tree from stdin, emit per-node bounds as JSON."""

import json
import sys
from fractions import Fraction

from .analyzer import analyze, to_json


def main():
    tree = json.load(sys.stdin, parse_float=Fraction, parse_int=Fraction)
    result = analyze(tree)
    json.dump(to_json(result), sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
