import fs from 'node:fs';
import { ReplanError, EXIT_CODES } from './errors.js';
import { parseDag, dependentClosure, DIMS } from './dag.js';
import { parseBudget, effectiveCost } from './budget.js';
import { findOptimalPlans, planCost } from './plan.js';
import { explainPlan, renderExplanation } from './explain.js';
import { newState, saveState, loadState, writeCheckpoint } from './state.js';
import { execute } from './runner.js';

const DEFAULT_STATE = 'state.json';

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new ReplanError('E_USAGE', `cannot read ${p}: ${e.message}`);
  }
}

function parseFlags(args) {
  const pos = [];
  const flags = { require: [], exclude: [], state: null, json: false, simulate: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--simulate') flags.simulate = true;
    else if (a === '--state') flags.state = args[++i] ?? missing('--state');
    else if (a === '--require') flags.require.push(args[++i] ?? missing('--require'));
    else if (a === '--exclude') flags.exclude.push(args[++i] ?? missing('--exclude'));
    else if (a.startsWith('--')) throw new ReplanError('E_USAGE', `unknown flag ${a}`);
    else pos.push(a);
  }
  return { pos, flags };
}

function missing(flag) {
  throw new ReplanError('E_USAGE', `flag ${flag} requires a value`);
}

// Exact id wins; otherwise unique prefix; multiple prefix matches: E_AMBIG.
function resolveTaskId(tasks, prefix) {
  if (tasks.has(prefix)) return prefix;
  const matches = [...tasks.keys()].filter((id) => id.startsWith(prefix)).sort();
  if (matches.length === 0) throw new ReplanError('E_UNKNOWN', `no task matches "${prefix}"`);
  if (matches.length > 1) {
    throw new ReplanError('E_AMBIG', `task prefix "${prefix}" is ambiguous: ${matches.join(', ')}`);
  }
  return matches[0];
}

function remainingBudget(tasks, budget, doneIds) {
  const used = { cpu: 0, mem: 0, wall: 0 };
  for (const id of doneIds) {
    const c = effectiveCost(tasks.get(id), budget);
    for (const d of DIMS) used[d] += c[d];
  }
  return Object.fromEntries(DIMS.map((d) => [d, budget[d] - used[d]]));
}

function planResultJson(tasks, effBudget, value, plans) {
  return {
    optimalValue: value,
    tiedPlanCount: plans.length,
    plans: plans.map((ids) => ({ tasks: ids, value, cost: planCost(tasks, effBudget, ids) })),
  };
}

function cmdPlan(args, io) {
  const { pos, flags } = parseFlags(args);
  if (pos.length !== 2) throw new ReplanError('E_USAGE', 'usage: replan plan <dag.json> <budget.json> [--require id]... [--exclude id]... [--state s.json] [--json]');
  const tasks = parseDag(readJson(pos[0]));
  const budget = parseBudget(readJson(pos[1]));

  let done = new Set();
  let excluded = [...flags.exclude];
  let effBudget = budget;
  if (flags.state) {
    const st = loadState(flags.state);
    done = new Set(st.completed);
    excluded = [...new Set([...st.excluded, ...excluded])];
    effBudget = remainingBudget(tasks, budget, done);
  }
  const { value, plans } = findOptimalPlans(tasks, effBudget, {
    require: flags.require,
    exclude: excluded,
    done,
  });
  const out = planResultJson(tasks, effBudget, value, plans);
  if (flags.state) out.remainingBudget = effBudget;
  io.stdout(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

function cmdRun(args, io) {
  const { pos, flags } = parseFlags(args);
  if (!flags.simulate) throw new ReplanError('E_USAGE', 'only simulated execution is supported: replan run --simulate <dag.json> <budget.json> [--state s.json]');
  if (pos.length !== 2) throw new ReplanError('E_USAGE', 'usage: replan run --simulate <dag.json> <budget.json> [--state s.json]');
  const dagDoc = readJson(pos[0]);
  const budgetDoc = readJson(pos[1]);
  const tasks = parseDag(dagDoc);
  const budget = parseBudget(budgetDoc);
  const { value, plans } = findOptimalPlans(tasks, budget, {});
  const statePath = flags.state ?? DEFAULT_STATE;
  const state = newState({
    dag: dagDoc,
    budget: budgetDoc,
    plan: plans[0],
    dagPath: pos[0],
    budgetPath: pos[1],
  });
  saveState(statePath, state);
  const result = execute(statePath, state);
  io.stdout(JSON.stringify({
    state: statePath,
    plannedValue: value,
    tiedPlanCount: plans.length,
    plan: plans[0],
    status: result.status,
    completed: result.state.completed,
    failed: result.state.failed,
    skipped: result.state.skipped,
    log: result.state.log,
  }, null, 2) + '\n');
  return result.status === 'crashed' ? EXIT_CODES.E_CRASH : 0;
}

function cmdCheckpoint(args, io) {
  const { pos, flags } = parseFlags(args);
  if (pos.length !== 1) throw new ReplanError('E_USAGE', 'usage: replan checkpoint <task> [--state s.json]');
  const statePath = flags.state ?? DEFAULT_STATE;
  const state = loadState(statePath);
  const tasks = parseDag(state.dag);
  const id = resolveTaskId(tasks, pos[0]);
  if (!state.plan.includes(id)) throw new ReplanError('E_USAGE', `task "${id}" is not in the current plan`);
  if (state.completed.includes(id)) throw new ReplanError('E_USAGE', `task "${id}" is already completed`);
  writeCheckpoint(statePath, state, id);
  state.log.push(`CKPT ${id} (manual)`);
  saveState(statePath, state);
  io.stdout(JSON.stringify({ checkpointed: id, state: statePath }) + '\n');
  return 0;
}

function cmdResume(args, io) {
  const { pos } = parseFlags(args);
  if (pos.length !== 1) throw new ReplanError('E_USAGE', 'usage: replan resume <state.json>');
  const state = loadState(pos[0]);
  const result = execute(pos[0], state);
  io.stdout(JSON.stringify({
    state: pos[0],
    status: result.status,
    completed: result.state.completed,
    failed: result.state.failed,
    skipped: result.state.skipped,
    log: result.state.log,
  }, null, 2) + '\n');
  return result.status === 'crashed' ? EXIT_CODES.E_CRASH : 0;
}

function cmdDeselect(args, io) {
  const { pos, flags } = parseFlags(args);
  if (pos.length !== 1) throw new ReplanError('E_USAGE', 'usage: replan deselect <task> [--state s.json]');
  const statePath = flags.state ?? DEFAULT_STATE;
  const state = loadState(statePath);
  const tasks = parseDag(state.dag);
  const budget = parseBudget(state.budget);
  const id = resolveTaskId(tasks, pos[0]);
  if (!state.plan.includes(id)) throw new ReplanError('E_USAGE', `task "${id}" is not in the current plan`);
  if (state.completed.includes(id)) throw new ReplanError('E_USAGE', `task "${id}" is already completed; its budget is spent`);

  // Remove the task and its not-yet-completed dependents from the plan.
  const done = new Set(state.completed);
  const removed = [...dependentClosure(tasks, [id])]
    .filter((t) => state.plan.includes(t) && !done.has(t));
  if (!state.excluded.includes(id)) state.excluded.push(id);

  // Freed budget triggers a full deterministic re-plan of the remainder.
  const effBudget = remainingBudget(tasks, budget, done);
  const { value, plans } = findOptimalPlans(tasks, effBudget, {
    exclude: state.excluded,
    done,
  });
  state.plan = plans[0];
  state.log.push(`DESELECT ${id}`);
  saveState(statePath, state);
  io.stdout(JSON.stringify({
    deselected: id,
    removedFromPlan: removed.sort(),
    freedBudgetTriggeringReplan: true,
    newPlan: state.plan,
    optimalValue: value,
    tiedPlanCount: plans.length,
    state: statePath,
  }, null, 2) + '\n');
  return 0;
}

function cmdExplain(args, io) {
  const { pos, flags } = parseFlags(args);
  if (pos.length !== 2) throw new ReplanError('E_USAGE', 'usage: replan explain <dag.json> <budget.json> [--state s.json] [--json]');
  const tasks = parseDag(readJson(pos[0]));
  const budget = parseBudget(readJson(pos[1]));
  let opts = {};
  let effBudget = budget;
  if (flags.state) {
    const st = loadState(flags.state);
    opts = { exclude: st.excluded, done: new Set(st.completed) };
    effBudget = remainingBudget(tasks, budget, st.completed);
  }
  const x = explainPlan(tasks, effBudget, opts);
  if (flags.json) io.stdout(JSON.stringify(x, null, 2) + '\n');
  else io.stdout(renderExplanation(x) + '\n');
  return 0;
}

const COMMANDS = {
  plan: cmdPlan,
  run: cmdRun,
  checkpoint: cmdCheckpoint,
  resume: cmdResume,
  deselect: cmdDeselect,
  explain: cmdExplain,
};

// In-process invocation: returns { code, stdout, stderr }. Fully
// deterministic and testable without spawning a child process.
export function runCli(argv) {
  const [cmd, ...rest] = argv;
  let stdout = '';
  let stderr = '';
  const io = { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } };
  let code;
  try {
    const handler = COMMANDS[cmd];
    if (!handler) {
      throw new ReplanError('E_USAGE', `unknown command "${cmd ?? ''}"; commands: ${Object.keys(COMMANDS).join(', ')}`);
    }
    code = handler(rest, io);
  } catch (e) {
    if (e instanceof ReplanError) {
      io.stderr(`${e.code}: ${e.message}\n`);
      code = EXIT_CODES[e.code] ?? 1;
    } else {
      io.stderr(`E_INTERNAL: ${e.stack ?? e.message}\n`);
      code = 1;
    }
  }
  return { code, stdout, stderr };
}

export function main(argv) {
  const { code, stdout, stderr } = runCli(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
