"""JSON command-line interface for the polygcd library."""

import argparse
import json
import sys
from fractions import Fraction

from .bezout import extended_gcd_rational, verify_bezout
from .engine import ModularGCDEngine


def _read_poly(spec):
    if spec.startswith("@"):
        with open(spec[1:], "r", encoding="utf-8") as fh:
            spec = fh.read()
    return tuple(int(c) for c in json.loads(spec))


def _enc_rational_poly(p):
    return [str(c) for c in p]


def _dec_rational_poly(data):
    return tuple(Fraction(c) for c in data)


def _dump(obj):
    json.dump(obj, sys.stdout, indent=2)
    sys.stdout.write("\n")


def _cmd_gcd(args):
    f = _read_poly(args.f)
    g = _read_poly(args.g)
    checkpoint = None
    if args.resume:
        with open(args.resume, "r", encoding="utf-8") as fh:
            checkpoint = json.load(fh)
    engine = ModularGCDEngine(f, g, prime_start=args.prime_start, checkpoint=checkpoint)
    result = engine.run(budget=args.budget)
    if args.state_out and result["checkpoint"] is not None:
        with open(args.state_out, "w", encoding="utf-8") as fh:
            json.dump(result["checkpoint"], fh, indent=2)
    _dump(result)
    return 0 if result["status"] == "ok" else 1


def _cmd_bezout(args):
    f = _read_poly(args.f)
    g = _read_poly(args.g)
    d, s, t = extended_gcd_rational(f, g)
    cert = {
        "f": list(f),
        "g": list(g),
        "d": _enc_rational_poly(d),
        "s": _enc_rational_poly(s),
        "t": _enc_rational_poly(t),
    }
    if args.cert_out:
        with open(args.cert_out, "w", encoding="utf-8") as fh:
            json.dump(cert, fh, indent=2)
    _dump({"certificate": cert, "self_check": verify_bezout(f, g, s, t, d)})
    return 0


def _cmd_verify(args):
    with open(args.cert, "r", encoding="utf-8") as fh:
        cert = json.load(fh)
    f = _read_poly(args.f) if args.f else tuple(int(c) for c in cert["f"])
    g = _read_poly(args.g) if args.g else tuple(int(c) for c in cert["g"])
    valid = verify_bezout(
        f,
        g,
        _dec_rational_poly(cert["s"]),
        _dec_rational_poly(cert["t"]),
        _dec_rational_poly(cert["d"]),
    )
    _dump({"valid": valid})
    return 0 if valid else 1


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="polygcd",
        description="Modular gcd of integer polynomials with verifiable output.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_gcd = sub.add_parser("gcd", help="modular gcd of two integer polynomials")
    p_gcd.add_argument("--f", required=True, help="JSON coeff list or @file")
    p_gcd.add_argument("--g", required=True, help="JSON coeff list or @file")
    p_gcd.add_argument("--budget", type=int, default=None,
                       help="max number of primes to consume this run")
    p_gcd.add_argument("--prime-start", type=int, default=2)
    p_gcd.add_argument("--resume", default=None, help="checkpoint JSON from a previous run")
    p_gcd.add_argument("--state-out", default=None, help="write checkpoint JSON here")
    p_gcd.set_defaults(func=_cmd_gcd)

    p_bez = sub.add_parser("bezout", help="extended gcd over Q with Bezout certificate")
    p_bez.add_argument("--f", required=True)
    p_bez.add_argument("--g", required=True)
    p_bez.add_argument("--cert-out", default=None, help="write certificate JSON here")
    p_bez.set_defaults(func=_cmd_bezout)

    p_ver = sub.add_parser("verify", help="independently verify a Bezout certificate")
    p_ver.add_argument("--cert", required=True, help="certificate JSON file")
    p_ver.add_argument("--f", default=None, help="override f (JSON or @file)")
    p_ver.add_argument("--g", default=None, help="override g (JSON or @file)")
    p_ver.set_defaults(func=_cmd_verify)

    args = parser.parse_args(argv)
    return args.func(args)
