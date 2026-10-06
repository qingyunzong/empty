import { readFileSync } from "node:fs";
import { parseRat, Rat } from "./rational";
import { solve, SolveResult, MAX_SEGMENTS } from "./solve";

interface CliInput {
  segments: { points: unknown[][] }[];
  line: { a: unknown; b: unknown; c: unknown };
  budget?: number;
  tol?: unknown;
}

export function run(input: CliInput): SolveResult {
  if (!Array.isArray(input.segments)) throw new Error("input.segments must be an array");
  if (input.segments.length > MAX_SEGMENTS)
    throw new Error(`at most ${MAX_SEGMENTS} segments allowed`);
  const segments = input.segments.map((s, i) => {
    if (!Array.isArray(s.points) || s.points.length !== 4)
      throw new Error(`segment ${i}: expected exactly 4 control points`);
    return s.points.map((p, j) => {
      if (!Array.isArray(p) || p.length !== 2)
        throw new Error(`segment ${i} point ${j}: expected [x, y]`);
      return [parseRat(p[0]), parseRat(p[1])] as [Rat, Rat];
    });
  });
  const line = {
    a: parseRat(input.line.a),
    b: parseRat(input.line.b),
    c: parseRat(input.line.c),
  };
  return solve(segments, line, {
    budget: input.budget,
    tol: input.tol !== undefined ? parseRat(input.tol) : undefined,
  });
}

if (require.main === module) {
  const arg = process.argv[2];
  try {
    const text =
      arg && arg !== "-" ? readFileSync(arg, "utf8") : readFileSync(0, "utf8");
    const result = run(JSON.parse(text) as CliInput);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
