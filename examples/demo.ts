import { execute } from '../src/executor.ts';
import { verifyAgainstModel } from '../src/verify.ts';
import type { TestCase } from '../src/graph.ts';

const cases: TestCase[] = [
  { id: 'auth', deps: [] },
  { id: 'cart', deps: ['auth'] },
  { id: 'checkout', deps: ['cart'] },
  { id: 'search', deps: [] },
  { id: 'report-a', deps: ['report-b'] },
  { id: 'report-b', deps: ['report-c'] },
  { id: 'report-c', deps: ['report-a'] },
  { id: 'report-export', deps: ['report-a'] },
];

// Controllable outcomes: auth fails, everything else would pass.
const outcome = (id: string) => id !== 'auth';

const summary = execute(cases, outcome);
console.log('Results (sorted by id):');
for (const r of summary.results) {
  console.log(`  ${r.id.padEnd(14)} ${r.status}`);
}
console.log(`Started: ${summary.started.join(', ')}`);

const v = verifyAgainstModel(cases, outcome);
console.log(`Model cross-check: ${v.ok ? 'OK' : 'MISMATCH'}`);
