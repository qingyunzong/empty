import { Engine } from './engine.js';
import { renderPlan } from './render.js';
import { QueryError } from './query.js';

function printPlan(lines, title, cost, plan) {
  lines.push(`${title} (cost ${cost}):`);
  lines.push(renderPlan(plan));
}

// Runs one CLI command against already-parsed JSON inputs and returns the
// text output. Throws QueryError on illegal queries.
export function runCommand(command, { catalog, data = {}, query, table, stats }) {
  const engine = new Engine(catalog, data);
  const lines = [];
  if (command === 'explain') {
    const r = engine.explain(query);
    printPlan(lines, 'plan', r.cost, r.plan);
    lines.push(`plan-string: ${r.planString}`);
  } else if (command === 'execute') {
    const r = engine.execute(query);
    printPlan(lines, 'plan', r.cost, r.plan);
    lines.push('rows:');
    lines.push(JSON.stringify(r.rows, null, 2));
    lines.push(`hash: ${r.hash}`);
  } else if (command === 'update-stats') {
    if (!table) throw new QueryError('missing required option --table');
    if (!stats) throw new QueryError('missing required option --stats');
    const before = engine.execute(query);
    const report = engine.updateStats(table, stats);
    lines.push(`table: ${report.table}`);
    lines.push(`invalidated plans: ${report.invalidated}`);
    if (report.invalidated === 0) {
      printPlan(lines, 'plan (unaffected)', before.cost, before.plan);
      lines.push(`hash: ${before.hash}`);
    }
    for (const chg of report.affected) {
      printPlan(lines, 'old plan', chg.oldCost, chg.oldPlanTree);
      printPlan(lines, 'new plan', chg.newCost, chg.newPlanTree);
      lines.push(`old hash: ${chg.oldHash}`);
      lines.push(`new hash: ${chg.newHash}`);
      lines.push(`hash delta: ${chg.hashChanged ? 'changed' : 'unchanged'}`);
    }
  } else {
    throw new QueryError(`unknown command: ${command}`);
  }
  return lines.join('\n');
}
