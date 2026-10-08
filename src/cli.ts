// CLI: parse a program file, validate the limits (<=3 threads, <=8
// instructions each), enumerate interleavings with and without
// independence-swap compression, and print the shortest error history.
//
// Usage: node dist/src/cli.js <program.txt> [--max-visited N]
// Exit code: 0 = no error found, 1 = error history found, 2 = bad input.

import { readFileSync } from 'node:fs';
import { MAX_INSTRS, MAX_THREADS, ParseError, parseProgram } from './lang.js';
import { DEFAULT_MAX_VISITED, exploreFull, explorePor, ExploreStats } from './explore.js';

function usage(): void {
  console.log('usage: node dist/src/cli.js <program.txt> [--max-visited N]');
  console.log(`limits: at most ${MAX_THREADS} threads, at most ${MAX_INSTRS} instructions per thread`);
  console.log('instructions: read rN | write <expr> | lock | unlock | assert <expr> <cmp> <expr>');
}

function printRow(mode: string, s: ExploreStats): void {
  const trunc = s.truncated ? ' (truncated)' : '';
  const shortest = s.shortest ? String(s.shortest.steps.length) : '-';
  console.log(
    `  ${mode.padEnd(5)} visited=${String(s.visited).padStart(8)}  ` +
      `executions=${String(s.executions).padStart(8)}  ` +
      `errors=${String(s.errorCount).padStart(6)}  shortest=${shortest}${trunc}`,
  );
}

export function run(argv: string[]): number {
  const args = argv.filter((a) => a !== '--');
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    return args.length === 0 ? 2 : 0;
  }
  const file = args[0];
  const mvIdx = args.indexOf('--max-visited');
  const maxVisited = mvIdx >= 0 ? parseInt(args[mvIdx + 1], 10) : DEFAULT_MAX_VISITED;
  if (mvIdx >= 0 && (!Number.isFinite(maxVisited) || maxVisited <= 0)) {
    console.error('input error: --max-visited expects a positive integer');
    return 2;
  }

  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    console.error(`input error: cannot read file: ${file}`);
    return 2;
  }

  let prog;
  try {
    prog = parseProgram(src);
  } catch (e) {
    if (e instanceof ParseError) {
      console.error(`input error: ${e.message}`);
      return 2;
    }
    throw e;
  }

  console.log(`program: ${file}`);
  console.log(`  shared x = ${prog.init}`);
  console.log(
    `  threads: ${prog.threads.length} (${prog.threads
      .map((t, i) => `t${i} "${t.name}": ${t.instrs.length} instrs`)
      .join(', ')})`,
  );

  const full = exploreFull(prog, maxVisited);
  const por = explorePor(prog, maxVisited);

  console.log('');
  console.log('exploration (full = every interleaving, por = independence-swap compressed):');
  printRow('full', full);
  printRow('por', por);
  console.log('');

  const shortest = full.shortest ?? por.shortest;
  if (!shortest) {
    console.log('result: no assertion failure, deadlock or bad unlock in any interleaving');
    return 0;
  }
  console.log(`result: shortest error history has ${shortest.steps.length} step(s):`);
  shortest.steps.forEach((st, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${st.text}`);
  });
  console.log(`  => ${shortest.error}`);
  return 1;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  process.exit(run(process.argv.slice(2)));
}
