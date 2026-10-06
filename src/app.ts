import { Rational } from "./rational.js";
import { solve, type LiquidInput } from "./solver.js";

export const USAGE = `blend - exact rational blending optimizer

Usage:
  node dist/src/cli.js [input.json] [--max-total N]
  cat input.json | node dist/src/cli.js

Input JSON:
{
  "liquids": [                     // 1..12 entries, order defines the amount vector
    { "name": "water",             // optional, default "liquid-<i>"
      "concentration": "0",        // rational: "p/q", decimal, or number (required)
      "cost": 1 },                 // non-negative integer per unit (required)
    { "name": "syrup", "concentration": "3/4", "cost": 4 }
  ],
  "target": ["1/4", "1/2"],        // closed interval [lo, hi]; or {"min": ..., "max": ...}
  "maxTotal": 40                   // optional, 1..40, default 40
}

Chooses non-negative integer unit amounts x_i with 1 <= sum(x) <= maxTotal and
lo <= sum(c_i x_i)/sum(x) <= hi, minimizing total integer cost, then the
lexicographically smallest amount vector. Prints the exact concentration and
amounts as JSON. Exit codes: 0 optimal, 1 infeasible (search completed),
2 usage/validation error.
`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CliInput {
  liquids: LiquidInput[];
  lo: Rational;
  hi: Rational;
  maxTotal: number;
}

function parseRational(value: unknown, where: string): Rational {
  if (typeof value === "number" || typeof value === "string") {
    try {
      return Rational.parse(String(value));
    } catch {
      throw new Error(`${where}: invalid rational ${JSON.stringify(value)}`);
    }
  }
  throw new Error(`${where}: expected a rational ("p/q", decimal string, or number)`);
}

function parseCost(value: unknown, where: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\+?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`${where}: cost must be a non-negative integer`);
}

export function parseInput(data: unknown): CliInput {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("input must be a JSON object");
  }
  const obj = data as Record<string, unknown>;

  const rawLiquids = obj.liquids;
  if (!Array.isArray(rawLiquids) || rawLiquids.length < 1) {
    throw new Error("liquids: expected a non-empty array");
  }
  if (rawLiquids.length > 12) {
    throw new Error(`liquids: at most 12 supported, got ${rawLiquids.length}`);
  }
  const liquids: LiquidInput[] = rawLiquids.map((raw, i) => {
    const where = `liquids[${i}]`;
    if (typeof raw !== "object" || raw === null) throw new Error(`${where}: expected an object`);
    const entry = raw as Record<string, unknown>;
    const name = entry.name === undefined ? `liquid-${i + 1}` : String(entry.name);
    if (entry.concentration === undefined) throw new Error(`${where}: missing concentration`);
    if (entry.cost === undefined) throw new Error(`${where}: missing cost`);
    const concentration = parseRational(entry.concentration, `${where}.concentration`);
    const cost = parseCost(entry.cost, `${where}.cost`);
    if (cost < 0n) throw new Error(`${where}.cost: must be non-negative`);
    return { name, concentration, cost };
  });

  const target = obj.target;
  let lo: Rational;
  let hi: Rational;
  if (Array.isArray(target) && target.length === 2) {
    lo = parseRational(target[0], "target[0]");
    hi = parseRational(target[1], "target[1]");
  } else if (typeof target === "object" && target !== null) {
    const t = target as Record<string, unknown>;
    lo = parseRational(t.min, "target.min");
    hi = parseRational(t.max, "target.max");
  } else {
    throw new Error('target: expected [lo, hi] or {"min": lo, "max": hi}');
  }
  if (lo.gt(hi)) throw new Error(`target: empty interval [${lo}, ${hi}]`);

  let maxTotal = 40;
  if (obj.maxTotal !== undefined) {
    const v = obj.maxTotal;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 40) {
      throw new Error("maxTotal: expected an integer in 1..40");
    }
    maxTotal = v;
  }
  return { liquids, lo, hi, maxTotal };
}

function formatOutput(input: CliInput, maxTotal: number): { code: number; stdout: string } {
  const result = solve(input.liquids, input.lo, input.hi, maxTotal);
  if (result.status === "infeasible" || result.solution === null) {
    return {
      code: 1,
      stdout:
        JSON.stringify(
          {
            status: "infeasible",
            target: [input.lo.toString(), input.hi.toString()],
            maxTotal,
            nodesExplored: result.nodesExplored,
          },
          null,
          2,
        ) + "\n",
    };
  }
  const sol = result.solution;
  return {
    code: 0,
    stdout:
      JSON.stringify(
        {
          status: "optimal",
          cost: Number(sol.cost),
          total: sol.total,
          concentration: sol.concentration.toString(),
          concentrationDecimal: sol.concentration.toNumber(),
          amounts: input.liquids.map((l, i) => ({ name: l.name, amount: sol.amounts[i] })),
          vector: sol.amounts,
          nodesExplored: result.nodesExplored,
        },
        null,
        2,
      ) + "\n",
  };
}

/**
 * Runs the CLI logic without touching process I/O.
 * `readStdin` / `readFile` are only invoked when actually needed.
 */
export function run(
  argv: string[],
  readStdin: () => string,
  readFile: (path: string) => string,
): CliResult {
  try {
    let file: string | null = null;
    let maxTotalOverride: number | null = null;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--help" || arg === "-h") {
        return { code: 0, stdout: USAGE, stderr: "" };
      } else if (arg === "--max-total") {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 1 || v > 40) {
          throw new Error("--max-total: expected an integer in 1..40");
        }
        maxTotalOverride = v;
      } else if (arg.startsWith("--")) {
        throw new Error(`unknown option: ${arg}`);
      } else if (file === null) {
        file = arg;
      } else {
        throw new Error(`unexpected argument: ${arg}`);
      }
    }

    const text = file === null ? readStdin() : readFile(file);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("input is not valid JSON");
    }
    const input = parseInput(data);
    const { code, stdout } = formatOutput(input, maxTotalOverride ?? input.maxTotal);
    return { code, stdout, stderr: "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: 2, stdout: "", stderr: `error: ${message}\ntry --help for usage\n` };
  }
}
