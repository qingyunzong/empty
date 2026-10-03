import { solve, CertWriter } from './solver.js';
import { validateInstance } from './instance.js';
import { invalidInput, PlannerError } from './errors.js';
import { GENESIS } from './canon.js';

// Session state shape:
// {
//   instance, pins: {step: param}, budgets: {maxNodes, maxCertBytes},
//   chain: [certificate entries across all operations],
//   checkpoints: { name: { chain, pins } },
//   lastSolve: { status, plan } | null
// }
export function initState(rawInstance) {
  const instance = validateInstance(rawInstance);
  return {
    instance,
    pins: {},
    budgets: { maxNodes: null, maxCertBytes: null },
    chain: [],
    checkpoints: {},
    lastSolve: null,
  };
}

function chainHead(state) {
  return state.chain.length ? state.chain[state.chain.length - 1].hash : GENESIS;
}

function pushMeta(state, entry) {
  // Meta entries share the same hash-chain format as solver entries.
  const writer = new CertWriter({ prevHash: chainHead(state), seqStart: state.chain.length });
  writer.push(entry);
  state.chain.push(...writer.entries);
}

// Run the solver on the current state, appending entries to the chain.
export function solveState(state) {
  const result = solve(state.instance, {
    pins: state.pins,
    maxNodes: state.budgets.maxNodes ?? Infinity,
    maxCertBytes: state.budgets.maxCertBytes ?? Infinity,
    prevHash: chainHead(state),
    seqStart: state.chain.length,
  });
  state.chain.push(...result.entries);
  state.lastSolve = { status: result.status, plan: result.plan };
  return state.lastSolve;
}

export function insertJob(state, job) {
  if (state.instance.steps.some((s) => s.id === job.id)) {
    throw invalidInput(`step ${JSON.stringify(job.id)} already exists`);
  }
  const candidate = {
    ...state.instance,
    steps: [...state.instance.steps, job],
  };
  state.instance = validateInstance(candidate);
  pushMeta(state, { type: 'insert_job', job: state.instance.steps[state.instance.steps.length - 1] });
  return solveState(state);
}

export function pin(state, step, param) {
  const s = state.instance.steps.find((x) => x.id === step);
  if (!s) throw invalidInput(`pin references unknown step ${JSON.stringify(step)}`);
  if (!s.params.includes(param)) {
    throw invalidInput(`pin value ${JSON.stringify(param)} not in domain of step ${JSON.stringify(step)}`);
  }
  state.pins[step] = param;
  pushMeta(state, { type: 'pin', step, param });
  return solveState(state);
}

export function unpin(state, step) {
  if (!(step in state.pins)) {
    throw invalidInput(`step ${JSON.stringify(step)} is not pinned`);
  }
  delete state.pins[step];
  pushMeta(state, { type: 'unpin', step });
  return solveState(state);
}

export function forkCheckpoint(state, name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw invalidInput('checkpoint name must be a non-empty string');
  }
  if (state.checkpoints[name]) {
    throw invalidInput(`checkpoint ${JSON.stringify(name)} already exists`);
  }
  state.checkpoints[name] = {
    chain: JSON.parse(JSON.stringify(state.chain)),
    pins: { ...state.pins },
  };
  return { status: 'FORKED', checkpoint: name, height: state.chain.length };
}

export function restoreCheckpoint(state, name) {
  const cp = state.checkpoints[name];
  if (!cp) throw invalidInput(`unknown checkpoint ${JSON.stringify(name)}`);
  state.chain = JSON.parse(JSON.stringify(cp.chain));
  state.pins = { ...cp.pins };
  state.lastSolve = null;
  return { status: 'RESTORED', checkpoint: name, height: state.chain.length };
}

// Merge is only allowed when one chain is a prefix of the other. Otherwise
// report CONFLICT with the earliest divergent edge of the hash chain.
export function mergeCheckpoint(state, name) {
  const cp = state.checkpoints[name];
  if (!cp) throw invalidInput(`unknown checkpoint ${JSON.stringify(name)}`);
  const a = state.chain;
  const b = cp.chain;
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i].hash === b[i].hash) i++;
  if (i < limit) {
    throw new PlannerError('CONFLICT', 'certificate chains diverge', {
      divergence: {
        index: i,
        edge: {
          from: i > 0 ? a[i - 1].hash : GENESIS,
          current: { seq: a[i].seq, hash: a[i].hash, entry: a[i].entry },
          checkpoint: { seq: b[i].seq, hash: b[i].hash, entry: b[i].entry },
        },
      },
    });
  }
  const merged = a.length >= b.length ? a : JSON.parse(JSON.stringify(b));
  state.chain = merged;
  return { status: 'MERGED', checkpoint: name, height: merged.length };
}
