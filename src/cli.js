import fs from 'node:fs';
import { ReplanError, EXIT_CODES } from './errors.js';
import { parseDag, parseBudget } from './dag.js';
import { planAll } from './planner.js';
import { fullPlanReport, taskReport } from './report.js';
import {
  initState, loadState, runSimulation, manualCheckpoint,
  SimulatedCrash, DEFAULT_ASSUME_FAIL_RATE,
} from './runner.js';

const USAGE = `replan — reproducible-experiment planner

usage:
  replan plan <dag.json> <budget.json> [--require a,b] [--drop a,b] [--json]
  replan run --simulate <dag.json> <budget.json> [--state path] [--plan-index N]
             [--seed N] [--assume-fail-rate X] [--crash-after-checkpoint T]
             [--require-unique] [--json]
  replan resume <state.json> [--crash-after-checkpoint T] [--json]
  replan checkpoint <state.json> <task> [--json]
  replan explain <dag.json> <budget.json> [task] [--json]

exit codes: 0 ok, 2 E_CYCLE, 3 E_BUDGET, 4 E_LOST_CKPT, 5 E_AMBIG, 6 E_INPUT, 64 E_USAGE, 75 simulated crash`;

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ReplanError('E_INPUT', `cannot read file: ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ReplanError('E_INPUT', `invalid JSON in file: ${file}`);
  }
}

function loadDagAndBudget(dagFile, budgetFile) {
  return { dag: parseDag(readJson(dagFile)), budget: parseBudget(readJson(budgetFile)) };
}

function parseFlags(args, { booleanFlags = [], valueFlags = [] } = {}) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (booleanFlags.includes(name)) {
        flags[name] = true;
      } else if (valueFlags.includes(name)) {
        if (i + 1 >= args.length) throw new ReplanError('E_USAGE', `flag --${name} needs a value`);
        flags[name] = args[++i];
      } else {
        throw new ReplanError('E_USAGE', `unknown flag: --${name}`);
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function splitList(v) {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function resolveTask(ids, prefix) {
  if (ids.includes(prefix)) return prefix;
  const matches = ids.filter((id) => id.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new ReplanError('E_INPUT', `unknown task: "${prefix}"`);
  throw new ReplanError('E_AMBIG', `ambiguous task "${prefix}": could be ${matches.join(', ')}`, { candidates: matches });
}

function fmtCost(c) {
  return `cpu=${c.cpu} mem=${c.mem} wall=${c.wall}`;
}

function printPlanReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`optimal value: ${report.value} — ${report.planCount} tied optimal plan(s)`);
  if (report.require.length) console.log(`required: ${report.require.join(', ')}`);
  if (report.drop.length) console.log(`dropped (budget released, re-planned): ${report.drop.join(', ')}`);
  report.plans.forEach((p, i) => {
    console.log(`plan #${i} [${p.key}] value=${p.value} cost ${fmtCost(p.cost)} reproducibility=[${p.reproducibility[0]}, ${p.reproducibility[1]}]`);
  });
}

function printRunSummary(state, json) {
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(`status: ${state.status}`);
  console.log(`plan: [${state.plan.join(', ')}]`);
  console.log(`completed: ${state.completed.length}/${state.plan.length}${state.failedTask ? ` (failed task: ${state.failedTask})` : ''}`);
  console.log(`consumed: ${fmtCost(state.consumed)} / budget ${fmtCost(state.budget)}`);
  console.log(`side effects applied: ${state.effects.length}, checkpoints: ${Object.keys(state.checkpoints).length}`);
  if (state.status === 'failed') {
    console.log(`recovery point: resume from state file; completed so far: [${state.completed.join(', ')}]`);
  }
}

function cmdPlan(args, json) {
  const { flags, pos } = parseFlags(args, { valueFlags: ['require', 'drop'] });
  if (pos.length !== 2) throw new ReplanError('E_USAGE', 'plan needs <dag.json> <budget.json>');
  const { dag, budget } = loadDagAndBudget(pos[0], pos[1]);
  const result = planAll(dag, budget, {
    require: splitList(flags.require),
    drop: splitList(flags.drop),
  });
  printPlanReport(fullPlanReport(dag, result), json);
  return 0;
}

function cmdRun(args, json) {
  const { flags, pos } = parseFlags(args, {
    booleanFlags: ['simulate', 'require-unique'],
    valueFlags: ['state', 'plan-index', 'seed', 'assume-fail-rate', 'crash-after-checkpoint'],
  });
  if (!flags.simulate) throw new ReplanError('E_USAGE', 'run currently supports only --simulate');
  if (pos.length !== 2) throw new ReplanError('E_USAGE', 'run needs <dag.json> <budget.json>');
  const { dag, budget } = loadDagAndBudget(pos[0], pos[1]);
  const result = planAll(dag, budget, {});
  if (flags['require-unique'] && result.plans.length > 1) {
    throw new ReplanError('E_AMBIG', `${result.plans.length} tied optimal plans; pass --plan-index or drop --require-unique`, {
      plans: result.plans.map((p) => p.key),
    });
  }
  const planIndex = flags['plan-index'] === undefined ? 0 : Number(flags['plan-index']);
  if (!Number.isInteger(planIndex) || planIndex < 0 || planIndex >= result.plans.length) {
    throw new ReplanError('E_INPUT', `--plan-index ${flags['plan-index']} out of range (0..${result.plans.length - 1})`);
  }
  const seed = flags.seed === undefined ? 1 : Number(flags.seed);
  if (!Number.isFinite(seed)) throw new ReplanError('E_INPUT', '--seed must be a number');
  const assumeFailRate = flags['assume-fail-rate'] === undefined ? DEFAULT_ASSUME_FAIL_RATE : Number(flags['assume-fail-rate']);
  if (!(assumeFailRate >= 0 && assumeFailRate <= 1)) throw new ReplanError('E_INPUT', '--assume-fail-rate must be in [0,1]');
  const statePath = flags.state ?? 'replan-state.json';
  const plan = result.plans[planIndex];
  const state = initState({ dag, budget, planIds: plan.tasks, planIndex, seed, assumeFailRate });
  const out = runSimulation(statePath, state, { crashAfterCheckpoint: flags['crash-after-checkpoint'] ?? null });
  printRunSummary(out, json);
  return 0;
}

function cmdResume(args, json) {
  const { flags, pos } = parseFlags(args, { valueFlags: ['crash-after-checkpoint'] });
  if (pos.length !== 1) throw new ReplanError('E_USAGE', 'resume needs <state.json>');
  const state = loadState(pos[0]);
  const out = runSimulation(pos[0], state, { crashAfterCheckpoint: flags['crash-after-checkpoint'] ?? null });
  printRunSummary(out, json);
  return 0;
}

function cmdCheckpoint(args, json) {
  const { pos } = parseFlags(args, {});
  if (pos.length !== 2) throw new ReplanError('E_USAGE', 'checkpoint needs <state.json> <task>');
  const state = loadState(pos[0]);
  const dag = parseDag(state.dag);
  const taskId = resolveTask(dag.ids, pos[1]);
  const file = manualCheckpoint(pos[0], state, taskId);
  if (json) console.log(JSON.stringify({ task: taskId, checkpoint: file }));
  else console.log(`checkpoint written for "${taskId}": ${file}`);
  return 0;
}

function cmdExplain(args, json) {
  const { pos } = parseFlags(args, {});
  if (pos.length !== 2 && pos.length !== 3) throw new ReplanError('E_USAGE', 'explain needs <dag.json> <budget.json> [task]');
  const { dag, budget } = loadDagAndBudget(pos[0], pos[1]);
  const result = planAll(dag, budget, {});
  if (pos.length === 3) {
    const taskId = resolveTask(dag.ids, pos[2]);
    const report = taskReport(dag, budget, result, taskId);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`task: ${report.id} — ${report.reason}`);
      console.log(`deps: [${report.deps.join(', ')}] dependents: [${report.dependents.join(', ')}]`);
      console.log(`closure: [${report.closure.join(', ')}] closure cost ${fmtCost(report.closureCost)}`);
      console.log(`effective cost ${fmtCost(report.cost)} (null resource = conservative upper bound)`);
      console.log(`failRate interval: [${report.failRateInterval}] success interval: [${report.successInterval}]`);
      console.log(`expected attempts interval: [${report.expectedAttemptsInterval}] max attempts: ${report.maxAttempts}`);
      console.log(`selected in plans: ${report.selectedInPlans.length ? report.selectedInPlans.map((i) => `#${i}`).join(', ') : '(none)'}`);
    }
    return 0;
  }
  const report = fullPlanReport(dag, result);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  printPlanReport(report, false);
  console.log('tasks:');
  for (const id of dag.ids) {
    const tr = taskReport(dag, budget, result, id);
    console.log(`  ${id}: ${tr.reason}; failRate=[${tr.failRateInterval}] expected attempts=[${tr.expectedAttemptsInterval}]`);
  }
  const first = report.plans[0];
  if (first && first.recoveryPoints.length) {
    console.log('recovery points (plan #0):');
    for (const rp of first.recoveryPoints) {
      console.log(`  ${rp.task}: on failure resume after [${rp.resumeAfter.join(', ')}], checkpoint ${rp.checkpoint}, max attempts ${rp.maxAttempts}`);
    }
  }
  return 0;
}

function dispatch(argv, json) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'plan': return cmdPlan(rest, json);
    case 'run': return cmdRun(rest, json);
    case 'resume': return cmdResume(rest, json);
    case 'checkpoint': return cmdCheckpoint(rest, json);
    case 'explain': return cmdExplain(rest, json);
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return cmd === undefined ? 64 : 0;
    default:
      throw new ReplanError('E_USAGE', `unknown command: ${cmd}`);
  }
}

export function main(argv) {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  try {
    return dispatch(args, json);
  } catch (e) {
    if (e instanceof SimulatedCrash) {
      const msg = `SIM_CRASH: ${e.message} — state saved, use "replan resume" to continue`;
      if (json) console.error(JSON.stringify({ error: { code: 'SIM_CRASH', message: e.message } }));
      else console.error(msg);
      return EXIT_CODES.SIM_CRASH;
    }
    if (e instanceof ReplanError) {
      if (json) console.error(JSON.stringify({ error: { code: e.code, message: e.message, details: e.details } }));
      else console.error(`${e.code}: ${e.message}`);
      return EXIT_CODES[e.code] ?? 1;
    }
    throw e;
  }
}
