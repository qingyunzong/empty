"""JSON command line interface for the verifier and the repairer."""

import argparse
import json
import sys

from .model import Certificate, Network, NetworkError
from .repairer import Repairer
from .verifier import Verifier

_REPAIR_EXIT_CODES = {"optimal": 0, "budget_exhausted": 2, "infeasible": 3}


def _load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _dump(payload, stream):
    json.dump(payload, stream, indent=2, sort_keys=True)
    stream.write("\n")


def _cmd_verify(args):
    network = Network.from_dict(_load_json(args.network))
    certificate = Certificate.from_dict(_load_json(args.certificate))
    verdict = Verifier(network).verify(certificate)
    _dump(verdict, sys.stdout)
    return 0 if verdict["valid"] else 1


def _cmd_repair(args):
    network = Network.from_dict(_load_json(args.network))
    certificate = Certificate.from_dict(_load_json(args.certificate))
    checkpoint = None
    if args.verbose:

        def checkpoint(payload):
            print(f"[checkpoint] {json.dumps(payload, sort_keys=True)}", file=sys.stderr)

    result = Repairer(network).repair(
        certificate.flows, budget=args.budget, checkpoint=checkpoint
    )
    _dump(result, sys.stdout)
    return _REPAIR_EXIT_CODES[result["status"]]


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="mcfcert",
        description="Min-cost flow certificate verifier and budgeted repairer",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_verify = sub.add_parser(
        "verify", help="independently verify a certificate against a network"
    )
    p_verify.add_argument("network", help="path to the network JSON file")
    p_verify.add_argument("certificate", help="path to the certificate JSON file")
    p_verify.set_defaults(func=_cmd_verify)

    p_repair = sub.add_parser(
        "repair", help="repair the flows of a certificate under a step budget"
    )
    p_repair.add_argument("network", help="path to the network JSON file")
    p_repair.add_argument(
        "certificate",
        help="path to a certificate JSON file (only its flows are repaired)",
    )
    p_repair.add_argument(
        "--budget",
        type=int,
        default=None,
        help="maximum number of search steps (default: unlimited)",
    )
    p_repair.add_argument(
        "--verbose",
        action="store_true",
        help="emit repair checkpoints to stderr",
    )
    p_repair.set_defaults(func=_cmd_repair)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (NetworkError, ValueError, OSError, json.JSONDecodeError) as exc:
        _dump({"error": str(exc)}, sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
