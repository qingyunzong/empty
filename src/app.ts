import { readFileSync, writeFileSync } from 'node:fs';
import { checkSolution } from './cert.js';
import { InputError, parseProblem } from './parse.js';
import { solveProblem } from './solve.js';
import { bruteForce } from './solver.js';
import type { Solution } from './types.js';

export const USAGE = `depfix — min-cost dependency-cycle repair (graphs with <= 18 edges)

Usage:
  depfix solve  <input.json> [--out solution.json] [--verify]
  depfix verify <input.json> [--solution solution.json]
  depfix check  <input.json> <solution.json>

Commands:
  solve   find a minimum-cost edge-deletion set making the graph acyclic
          (locked edges kept, entry->exit reachability preserved,
          group prerequisites honored, budget respected)
  verify  exhaustively enumerate all deletion subsets and report the optimum
  check   independently validate a solution file (constraints + optimality)

Exit codes: 0 ok/optimal, 1 infeasible, 2 usage or input error, 3 check failed
`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new InputError(`cannot read/parse ${path}: ${(err as Error).message}`);
  }
}

/** Run the CLI in-process; returns exit code and captured output. */
export function runCli(argv: string[]): CliResult {
  let stdout = '';
  let stderr = '';
  try {
    const code = dispatch(argv, (s) => (stdout += s), (s) => (stderr += s));
    return { code, stdout, stderr };
  } catch (err) {
    if (err instanceof InputError) {
      return { code: 2, stdout, stderr: stderr + `input error: ${err.message}\n` };
    }
    throw err;
  }
}

function dispatch(
  argv: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && a !== '--out' && a !== '--solution'));
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const solIdx = argv.indexOf('--solution');
  const solPath = solIdx !== -1 ? argv[solIdx + 1] : undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--out' || a === '--solution') {
      i++; // skip value
      continue;
    }
    if (a.startsWith('--')) continue;
    positional.push(a);
  }
  const cmd = positional[0];
  const rest = positional.slice(1);

  if (cmd === 'solve') {
    const inputPath = rest[0];
    if (!inputPath) throw new InputError('solve: missing <input.json>');
    const problem = parseProblem(readJson(inputPath));
    const sol = solveProblem(problem, { verify: flags.has('--verify') });
    const text = JSON.stringify(sol, null, 2) + '\n';
    if (outPath) writeFileSync(outPath, text);
    else out(text);
    if (sol.status === 'optimal') {
      err(
        `optimal cost ${sol.totalCost}, deleted ${sol.deletedEdges!.length} edge(s)` +
          (sol.proof?.enumeration ? `, enumeration check: ${sol.proof.enumeration.matches ? 'MATCH' : 'MISMATCH'}` : '') +
          '\n',
      );
      return 0;
    }
    err(`infeasible: ${sol.infeasible!.reason}\n`);
    return 1;
  }

  if (cmd === 'verify') {
    const inputPath = rest[0];
    if (!inputPath) throw new InputError('verify: missing <input.json>');
    const problem = parseProblem(readJson(inputPath));
    const bf = bruteForce(problem);
    const report: Record<string, unknown> = {
      deletableEdges: bf.stats.deletableEdges,
      subsetsChecked: 1 << bf.stats.deletableEdges,
      optimalCost: bf.cost,
    };
    if (solPath) {
      const sol = readJson(solPath) as Solution;
      report.solutionCost = sol.totalCost ?? null;
      report.matches = sol.totalCost === bf.cost;
    }
    out(JSON.stringify(report, null, 2) + '\n');
    if (solPath && report.matches === false) return 3;
    return bf.mask === null ? 1 : 0;
  }

  if (cmd === 'check') {
    const [inputPath, solutionPath] = rest;
    if (!inputPath || !solutionPath) throw new InputError('check: missing <input.json> <solution.json>');
    const problem = parseProblem(readJson(inputPath));
    const sol = readJson(solutionPath) as Solution;
    const res = checkSolution(problem, sol);
    if (res.valid) {
      out('OK: solution is valid and optimal\n');
      return 0;
    }
    for (const e of res.errors) err(`INVALID: ${e}\n`);
    return 3;
  }

  err(USAGE);
  return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
}
