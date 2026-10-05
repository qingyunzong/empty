/** Command-line interface: parse a program, run reduced and full exploration. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseProgram, ParseError } from './parser';
import { exploreDpor } from './dpor';
import { exploreFull } from './full';
import { ExploreResult, TraceStep } from './explore';
import { MAX_INSTRS_PER_THREAD, MAX_THREADS } from './model';

const USAGE = `Usage: node dist/src/cli.js <program.prog> [options]

Verifies a concurrent program (<= ${MAX_THREADS} threads, <= ${MAX_INSTRS_PER_THREAD} instructions
per thread; instructions: read, write, lock, unlock, assert) by enumerating
thread interleavings.

Options:
  --mode <both|por|full>  exploration to run (default: both)
  --budget <n>            max executed transitions per exploration
  --json                  print machine-readable JSON
  --help                  show this help

Exit code: 0 = SAFE, 1 = UNSAFE (error history found), 2 = usage/parse error.`;

function printTrace(trace: TraceStep[], prefix: string): void {
  trace.forEach((s, i) => {
    console.log(`${prefix}${i + 1}. [${s.threadName}] ${s.instrText}`);
  });
}

function printResult(label: string, result: ExploreResult): void {
  const stats = result.stats;
  const parts = [`transitions=${stats.transitions}`];
  if (stats.states !== undefined) parts.push(`states=${stats.states}`);
  if (stats.executions !== undefined) parts.push(`executions=${stats.executions}`);
  console.log(`--- ${label}: ${result.verdict} (${parts.join(', ')})`);
  if (result.shortestError !== null) {
    const finding = result.findings.find(f => f.trace === result.shortestError)!;
    console.log(`shortest error history (${result.shortestError.length} steps): ${finding.violation.message}`);
    printTrace(result.shortestError, '  ');
  }
}

function main(): number {
  let args;
  try {
    args = parseArgs({
      options: {
        mode: { type: 'string', default: 'both' },
        budget: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    return 2;
  }

  if (args.values.help || args.positionals.length !== 1) {
    console.log(USAGE);
    return args.values.help ? 0 : 2;
  }
  const mode = args.values.mode as string;
  if (mode !== 'both' && mode !== 'por' && mode !== 'full') {
    console.error(`unknown mode '${mode}'`);
    return 2;
  }
  const budget = args.values.budget !== undefined ? parseInt(args.values.budget as string, 10) : undefined;
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
    console.error(`invalid budget '${args.values.budget}'`);
    return 2;
  }

  const file = args.positionals[0];
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    console.error(`cannot read file '${file}'`);
    return 2;
  }

  let program;
  try {
    program = parseProgram(source);
  } catch (e) {
    if (e instanceof ParseError) {
      console.error(`parse error in ${file}: ${e.message}`);
      return 2;
    }
    throw e;
  }

  const results: Record<string, ExploreResult> = {};
  if (mode === 'both' || mode === 'por') results.por = exploreDpor(program, budget);
  if (mode === 'both' || mode === 'full') results.full = exploreFull(program, budget);

  if (args.values.json) {
    console.log(JSON.stringify({ file, ...results }, null, 2));
  } else {
    console.log(`program: ${file} (${program.threads.length} threads, ` +
      `${program.threads.map(t => t.instrs.length).join('+')} instructions)`);
    if (results.por) printResult('POR (swap-reduced)', results.por);
    if (results.full) printResult('full (uncompressed)', results.full);
    if (results.por && results.full) {
      const sameVerdict = results.por.verdict === results.full.verdict;
      const sameLen = (results.por.shortestError?.length ?? null) === (results.full.shortestError?.length ?? null);
      console.log(`--- comparison: verdicts ${sameVerdict ? 'agree' : 'DISAGREE'}, ` +
        `shortest-error lengths ${sameLen ? 'agree' : 'DISAGREE'}, ` +
        `transitions ${results.por.stats.transitions} (por) vs ${results.full.stats.transitions} (full)`);
    }
  }

  const finalVerdict = results.por?.verdict ?? results.full?.verdict ?? 'SAFE';
  return finalVerdict === 'UNSAFE' ? 1 : finalVerdict === 'INCOMPLETE' ? 2 : 0;
}

process.exit(main());
