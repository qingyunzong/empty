import { readFileSync } from "node:fs";
import { InputError, MAX_AMOUNT } from "./graph";
import { solve } from "./mincostflow";
import { enumerateFlows } from "./enumerate";
import { NetworkSpec } from "./types";

const USAGE = `transfer-cli: min-cost transfer on a directed account graph

Usage:
  node dist/src/cli.js [options] < input.json
  node dist/src/cli.js --input network.json

Options:
  -i, --input <file>   Read the network spec from a file (default: stdin)
  -a, --amount <n>     Override the amount in the spec (integer 0..${MAX_AMOUNT})
      --at-most        Minimize cost over every flow value in [0, amount]
      --enumerate      Cross-check against brute-force enumeration (small nets)
  -h, --help           Show this help

Input JSON:
  {
    "nodes":  ["A", "B", "C"],              // optional; inferred from edges
    "source": "A",
    "sink":   "C",
    "amount": 4,                            // integer, 0..${MAX_AMOUNT}
    "atMost": false,                        // optional
    "edges": [
      { "from": "A", "to": "B", "capacity": 3,
        "segments": [ { "upTo": 2, "unitCost": 1 },
                      { "upTo": 3, "unitCost": 4 } ] }
    ]
  }

Segment fees are per-unit and must be non-decreasing (convex). Negative fees
are allowed; inputs containing a negative-cost cycle are rejected.

Exit codes: 0 = optimal, 2 = infeasible, 1 = invalid input or internal error.
`;

interface CliArgs {
  input?: string;
  amount?: number;
  atMost: boolean;
  enumerate: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { atMost: false, enumerate: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-i":
      case "--input":
        args.input = argv[++i];
        if (args.input === undefined) throw new InputError(`${arg} requires a file path`);
        break;
      case "-a":
      case "--amount": {
        const raw = argv[++i];
        const value = raw === undefined ? NaN : Number(raw);
        if (!Number.isInteger(value) || value < 0 || value > MAX_AMOUNT) {
          throw new InputError(`${arg} requires an integer in [0, ${MAX_AMOUNT}]`);
        }
        args.amount = value;
        break;
      }
      case "--at-most":
        args.atMost = true;
        break;
      case "--enumerate":
        args.enumerate = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new InputError(`unknown option: ${arg}`);
    }
  }
  return args;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const text = args.input === undefined ? readFileSync(0, "utf8") : readFileSync(args.input, "utf8");
  const spec = JSON.parse(text) as NetworkSpec;
  if (args.amount !== undefined) spec.amount = args.amount;
  if (args.atMost) spec.atMost = true;

  const result = solve(spec);

  let enumeration: unknown;
  if (args.enumerate) {
    const brute = enumerateFlows(spec);
    const exactCost = brute.costByAmount[spec.amount] ?? null;
    const matches = spec.atMost
      ? brute.bestAtMost !== null &&
        brute.bestAtMost.sent === result.sent &&
        brute.bestAtMost.cost === result.totalCost
      : exactCost !== null && result.status === "optimal" && exactCost === result.totalCost;
    enumeration = {
      checked: true,
      matches,
      combinations: brute.combinations,
      costByAmount: brute.costByAmount,
      bestAtMost: brute.bestAtMost,
    };
  }

  process.stdout.write(JSON.stringify({ ...result, ...(enumeration ? { enumeration } : {}) }, null, 2) + "\n");
  return result.status === "optimal" ? 0 : 2;
}

try {
  process.exitCode = main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`transfer-cli: error: ${message}\n`);
  process.exitCode = 1;
}
