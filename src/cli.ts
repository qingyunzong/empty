import {
  parsePattern,
  formatPattern,
  PatternError,
  MAX_SEGMENTS,
  MAX_EXCLUDES,
} from "./pattern.js";
import { searchIntersection, DEFAULT_BUDGET, type SearchResult } from "./search.js";
import { crossCheck } from "./verify.js";

export const EXIT_COMMON = 0;
export const EXIT_DISJOINT = 1;
export const EXIT_UNKNOWN = 2;
export const EXIT_USAGE = 64;

const USAGE = `path-rules: decide whether two path patterns share a common path

usage:
  path-rules intersect <patternA> <patternB> [options]

pattern syntax:
  literal   one or more lowercase letters [a-z]+
  *         matches exactly one segment
  **        whole segment, matches zero or more segments
  (empty segments and partial wildcards like "a*" are rejected;
   at most ${MAX_SEGMENTS} segments per pattern)

options:
  --exclude <pattern>   exclude pattern (repeatable, at most ${MAX_EXCLUDES});
                        a witness must match both allows and no exclude
  --budget <n>          max search states expanded before reporting
                        "unknown" (default ${DEFAULT_BUDGET})
  --verify [n]          accept the result by exhaustive enumeration of the
                        short domain (all paths with up to n segments over
                        the literals in play plus one fresh symbol;
                        default n = max(6, witness length))
  --json                print the result as JSON

exit codes: 0 common, 1 disjoint, 2 unknown, 64 usage error
`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Options {
  excludes: string[];
  budget: number;
  verify: number | null;
  json: boolean;
}

class EarlyExit extends Error {}

function parseArgs(argv: string[]): { a: string; b: string; options: Options } {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    throw new EarlyExit();
  }
  const positional: string[] = [];
  const options: Options = { excludes: [], budget: DEFAULT_BUDGET, verify: null, json: false };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k]!;
    if (arg === "--exclude") {
      const value = argv[++k];
      if (value === undefined) throw new PatternError("--exclude requires a pattern");
      options.excludes.push(value);
    } else if (arg === "--budget") {
      const value = argv[++k];
      if (value === undefined || !/^[0-9]+$/.test(value)) {
        throw new PatternError("--budget requires a non-negative integer");
      }
      options.budget = Number(value);
    } else if (arg === "--verify") {
      const next = argv[k + 1];
      if (next !== undefined && /^[0-9]+$/.test(next)) {
        options.verify = Number(next);
        k++;
      } else {
        options.verify = -1; // sentinel: choose default later
      }
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--")) {
      throw new PatternError(`unknown option "${arg}"`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    throw new PatternError(`expected exactly 2 allow patterns, got ${positional.length}`);
  }
  if (options.excludes.length > MAX_EXCLUDES) {
    throw new PatternError(
      `too many exclude patterns: ${options.excludes.length}, max is ${MAX_EXCLUDES}`,
    );
  }
  return { a: positional[0]!, b: positional[1]!, options };
}

function formatWitness(witness: string[]): string {
  return witness.length === 0 ? "<empty>" : witness.join("/");
}

/** Run the CLI against argv (excluding node/script) and capture output. */
export function runCli(argv: string[]): CliResult {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof EarlyExit) {
      return { code: argv.length === 0 ? EXIT_USAGE : EXIT_COMMON, stdout: USAGE, stderr: "" };
    }
    return {
      code: EXIT_USAGE,
      stdout: "",
      stderr: `error: ${(err as Error).message}\n\n${USAGE}`,
    };
  }

  let allowA, allowB, excludes;
  try {
    allowA = parsePattern(parsed.a);
    allowB = parsePattern(parsed.b);
    excludes = parsed.options.excludes.map(parsePattern);
  } catch (err) {
    return { code: EXIT_USAGE, stdout: "", stderr: `error: ${(err as Error).message}\n` };
  }

  const result: SearchResult = searchIntersection(allowA, allowB, excludes, parsed.options.budget);

  let verification: string | null = null;
  if (parsed.options.verify !== null && result.status !== "unknown") {
    const maxLen =
      parsed.options.verify >= 0
        ? parsed.options.verify
        : Math.max(6, result.status === "common" ? result.witness.length : 0);
    const check = crossCheck(allowA, allowB, excludes, maxLen, parsed.options.budget);
    verification = check.consistent ? `yes (${check.note})` : `NO (${check.note})`;
  }

  let stdout: string;
  if (parsed.options.json) {
    stdout =
      JSON.stringify(
        {
          allow: [formatPattern(allowA), formatPattern(allowB)],
          excludes: excludes.map(formatPattern),
          status: result.status,
          witness: result.status === "common" ? result.witness : null,
          expansions: result.expansions,
          verified: verification,
        },
        null,
        2,
      ) + "\n";
  } else {
    stdout = `status: ${result.status}\n`;
    if (result.status === "common") {
      stdout += `witness: ${formatWitness(result.witness)}\n`;
      stdout += `segments: ${result.witness.length}\n`;
    }
    stdout += `expansions: ${result.expansions}\n`;
    if (verification !== null) stdout += `verified: ${verification}\n`;
  }

  const code =
    result.status === "common"
      ? EXIT_COMMON
      : result.status === "disjoint"
        ? EXIT_DISJOINT
        : EXIT_UNKNOWN;
  return { code, stdout, stderr: "" };
}

const invokedAsScript =
  typeof process.argv[1] === "string" && /(^|\/)cli\.(js|ts)$/.test(process.argv[1]);
if (invokedAsScript) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
