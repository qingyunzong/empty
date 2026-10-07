import process from "node:process";
import {
  parsePattern,
  PatternError,
  MAX_EXCLUDES,
  MAX_PATTERN_SEGMENTS,
} from "./pattern";
import { findWitness, DEFAULT_BUDGET, DEFAULT_MAX_DEPTH } from "./search";

const USAGE = `Usage: pathrule <allow1> <allow2> [options]

Decide whether two path-rule patterns share a path and print a witness.

Patterns: '/'-separated segments; each segment is a lowercase literal [a-z]+,
'*' (exactly one segment) or '**' (zero or more whole segments). Empty
segments are rejected. Each pattern has at most ${MAX_PATTERN_SEGMENTS} segments.

Options:
  -x, --exclude <pat>   exclude pattern; repeatable, comma-separated allowed
                        (at most ${MAX_EXCLUDES} excludes)
  --budget <n>          max frontier expansions (default ${DEFAULT_BUDGET})
  --max-depth <n>       max witness segments (default ${DEFAULT_MAX_DEPTH})
  -h, --help            show this help

Output:
  WITNESS <path>   common path with fewest segments, then byte-smallest
                   (exit 0); "(empty)" denotes the zero-segment path
  EMPTY            provably no common path (exit 1)
  UNKNOWN: <why>   budget/depth exhausted, neither proven (exit 2)
  invalid usage or patterns exit with code 3`;

function parseNonNegativeInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new PatternError(`invalid value "${value}" for ${flag}`);
  }
  return Number(value);
}

export function run(argv: string[]): number {
  const positional: string[] = [];
  const excludeSrc: string[] = [];
  let budget: number | undefined;
  let maxDepth: number | undefined;

  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "-h" || a === "--help") {
        console.log(USAGE);
        return 0;
      } else if (a === "-x" || a === "--exclude") {
        const v = argv[++i];
        if (v === undefined) throw new PatternError(`missing value for ${a}`);
        excludeSrc.push(...v.split(",").filter((s) => s.length > 0));
      } else if (a === "--budget") {
        const v = argv[++i];
        if (v === undefined) throw new PatternError("missing value for --budget");
        budget = parseNonNegativeInt(v, "--budget");
      } else if (a === "--max-depth") {
        const v = argv[++i];
        if (v === undefined) throw new PatternError("missing value for --max-depth");
        maxDepth = parseNonNegativeInt(v, "--max-depth");
      } else if (a.startsWith("-")) {
        throw new PatternError(`unknown option "${a}"`);
      } else {
        positional.push(a);
      }
    }

    if (positional.length !== 2) {
      console.error(USAGE);
      return 3;
    }
    if (excludeSrc.length > MAX_EXCLUDES) {
      throw new PatternError(
        `too many exclude patterns: ${excludeSrc.length} (max ${MAX_EXCLUDES})`
      );
    }

    const allow1 = parsePattern(positional[0]!);
    const allow2 = parsePattern(positional[1]!);
    const excludes = excludeSrc.map(parsePattern);

    const result = findWitness(allow1, allow2, excludes, { budget, maxDepth });
    if (result.status === "witness") {
      const shown = result.path.length === 0 ? "(empty)" : result.path.join("/");
      console.log(`WITNESS ${shown}`);
      return 0;
    }
    if (result.status === "empty") {
      console.log("EMPTY");
      return 1;
    }
    console.log(`UNKNOWN: ${result.reason}`);
    return 2;
  } catch (e) {
    if (e instanceof PatternError) {
      console.error(`error: ${e.message}`);
      return 3;
    }
    throw e;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
