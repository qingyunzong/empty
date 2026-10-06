// Solve a problem given as a JSON file and print the whole-tree allocation,
// every node's aggregate, and (for constrained problems) the cross-edge
// certificate. Usage: npm run solve -- examples/problem.json
import { readFileSync } from 'node:fs';
import { Problem } from './model';
import { solveTreeDp } from './treeDp';
import { ConstrainedSolver } from './constrained';

const file = process.argv[2];
if (!file) {
  console.error('usage: node dist/src/cli.js <problem.json>');
  process.exit(1);
}
const problem = JSON.parse(readFileSync(file, 'utf8')) as Problem;
const hasConstraints = (problem.constraints ?? []).length > 0;

if (hasConstraints) {
  const solver = new ConstrainedSolver(problem);
  console.log(JSON.stringify(solver.run(), null, 2));
} else {
  console.log(JSON.stringify(solveTreeDp(problem), null, 2));
}
