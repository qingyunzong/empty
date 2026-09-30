"""Command line interface for the verified interval Newton solver."""
import json
import sys
from fractions import Fraction

from .solver import MultipleRootsError, solve

USAGE = """\
usage: python -m interval_newton COEFFS_FILE INTERVAL EPS
       python -m interval_newton COEFFS_FILE A B EPS

COEFFS_FILE: polynomial coefficients, leading term first, either as a JSON
             array or whitespace separated rationals (e.g. '1 0 -2' for
             x^2 - 2). Rationals may be given as 'p/q' or decimals.
INTERVAL:    search interval as 'A,B' (brackets optional), or two separate
             arguments A and B.
EPS:         positive rational bound on the output enclosure width.

Output: JSON list of [lo, hi] rational intervals on stdout, each enclosing
        exactly one real root. Exit code 0 on success, 4 if the polynomial
        has a multiple root, 2 on usage/input errors.
"""


def _parse_coeffs(text):
    text = text.strip()
    if not text:
        raise ValueError("empty coefficient file")
    if text.startswith("["):
        data = json.loads(text, parse_float=Fraction)
        if not isinstance(data, list) or not data:
            raise ValueError("coefficient JSON must be a non-empty array")
        return [Fraction(x) for x in data]
    tokens = [
        token
        for line in text.splitlines()
        if not line.lstrip().startswith("#")
        for token in line.split()
    ]
    if not tokens:
        raise ValueError("empty coefficient file")
    return [Fraction(token) for token in tokens]


def _parse_interval(spec):
    parts = spec.strip().strip("[]()").split(",")
    if len(parts) != 2:
        raise ValueError(f"invalid interval: {spec!r}")
    return Fraction(parts[0]), Fraction(parts[1])


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) == 3:
            coeffs_path, interval_spec, eps_spec = argv
            a, b = _parse_interval(interval_spec)
        elif len(argv) == 4:
            coeffs_path, a_spec, b_spec, eps_spec = argv
            a, b = Fraction(a_spec), Fraction(b_spec)
        else:
            sys.stderr.write(USAGE)
            return 2
        eps = Fraction(eps_spec)
        with open(coeffs_path, "r", encoding="utf-8") as fh:
            coeffs = _parse_coeffs(fh.read())
        enclosures = solve(coeffs, a, b, eps)
    except MultipleRootsError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 4
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 2
    sys.stdout.write(json.dumps([[str(lo), str(hi)] for lo, hi in enclosures]) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
