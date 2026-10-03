import { canon, sha256 } from "./canon.js";
import { InputError, normalizeSpec, specHashOf } from "./spec.js";
import { solve } from "./solver.js";

export const SESSION_VERSION = 1;

function genesis(specHash) {
  return sha256(`repro-session/1:${specHash}`);
}

function appendOp(branch, op) {
  const entry = { i: branch.entries.length, ...op };
  entry.hash = sha256(branch.head + ":" + canon(entry));
  branch.entries.push(entry);
  branch.head = entry.hash;
  return entry;
}

function requireBranch(state, name) {
  const branch = state.branches[name];
  if (!branch) throw new InputError(`unknown branch "${name}"`);
  return branch;
}

export function initState(rawSpec) {
  const norm = normalizeSpec(rawSpec);
  const spec = JSON.parse(JSON.stringify(rawSpec));
  return {
    version: SESSION_VERSION,
    spec,
    pins: {},
    branches: { main: { entries: [], head: genesis(specHashOf(norm)) } },
  };
}

export function loadState(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InputError("state must be a JSON object");
  }
  if (raw.version !== SESSION_VERSION) throw new InputError(`unsupported state version "${raw.version}"`);
  if (raw.pins === null || typeof raw.pins !== "object" || Array.isArray(raw.pins)) {
    throw new InputError("state.pins must be an object");
  }
  if (raw.branches === null || typeof raw.branches !== "object" || Array.isArray(raw.branches)) {
    throw new InputError("state.branches must be an object");
  }
  normalizeSpec(raw.spec);
  for (const [name, branch] of Object.entries(raw.branches)) {
    if (!Array.isArray(branch.entries) || typeof branch.head !== "string") {
      throw new InputError(`branch "${name}" is malformed`);
    }
  }
  return raw;
}

export function effectiveSpec(state) {
  const spec = JSON.parse(JSON.stringify(state.spec));
  const domains = new Map(spec.steps.map((s) => [s.id, new Set(s.params)]));
  for (const step of spec.steps) {
    if (Object.prototype.hasOwnProperty.call(state.pins, step.id)) {
      step.params = [state.pins[step.id]];
      domains.set(step.id, new Set(step.params));
    }
  }
  if (spec.compat && typeof spec.compat === "object") {
    for (const [key, table] of Object.entries(spec.compat)) {
      const [u, v] = key.split(">");
      if (!domains.has(u) || !domains.has(v) || table === null || typeof table !== "object") continue;
      for (const pu of Object.keys(table)) {
        if (!domains.get(u).has(pu)) {
          delete table[pu];
        } else if (Array.isArray(table[pu])) {
          table[pu] = table[pu].filter((pv) => domains.get(v).has(pv));
        }
      }
    }
  }
  return spec;
}

export function pin(state, stepId, param, branchName = "main") {
  const norm = normalizeSpec(state.spec);
  if (!norm.index.has(stepId)) throw new InputError(`unknown step "${stepId}"`);
  const step = norm.steps[norm.index.get(stepId)];
  if (!step.params.includes(param)) {
    throw new InputError(`step "${stepId}" has no param "${param}" in its domain`);
  }
  state.pins[stepId] = param;
  appendOp(requireBranch(state, branchName), { type: "pin", step: stepId, param });
  return state;
}

export function unpin(state, stepId, branchName = "main") {
  const norm = normalizeSpec(state.spec);
  if (!norm.index.has(stepId)) throw new InputError(`unknown step "${stepId}"`);
  if (!Object.prototype.hasOwnProperty.call(state.pins, stepId)) {
    throw new InputError(`step "${stepId}" is not pinned`);
  }
  delete state.pins[stepId];
  appendOp(requireBranch(state, branchName), { type: "unpin", step: stepId });
  return state;
}

export function insertJob(state, job, edges = [], branchName = "main") {
  const candidate = JSON.parse(JSON.stringify(state.spec));
  if (!Array.isArray(candidate.steps)) throw new InputError("state spec has no steps");
  if (!job || typeof job !== "object" || Array.isArray(job)) throw new InputError("job must be an object");
  if (typeof job.id === "string" && candidate.steps.some((s) => s.id === job.id)) {
    throw new InputError(`duplicate step id "${job.id}"`);
  }
  candidate.steps.push(job);
  if (!Array.isArray(candidate.edges)) candidate.edges = [];
  for (const e of edges) candidate.edges.push(e);
  normalizeSpec(candidate);
  state.spec = candidate;
  appendOp(requireBranch(state, branchName), { type: "insert_job", step: job.id ?? null });
  return state;
}

export function forkCheckpoint(state, name, from = "main") {
  if (typeof name !== "string" || name.length === 0) throw new InputError("branch name must be a non-empty string");
  if (state.branches[name]) throw new InputError(`branch "${name}" already exists`);
  const src = requireBranch(state, from);
  state.branches[name] = { entries: JSON.parse(JSON.stringify(src.entries)), head: src.head };
  return state;
}

export function mergeCheckpoint(state, srcName, dstName) {
  const src = requireBranch(state, srcName);
  const dst = requireBranch(state, dstName);
  const len = Math.min(src.entries.length, dst.entries.length);
  let i = 0;
  while (i < len && src.entries[i].hash === dst.entries[i].hash) i++;
  const srcRest = src.entries.length - i;
  const dstRest = dst.entries.length - i;
  if (srcRest === 0 || dstRest === 0) {
    const longer = src.entries.length >= dst.entries.length ? src : dst;
    state.branches[dstName] = { entries: JSON.parse(JSON.stringify(longer.entries)), head: longer.head };
    return { status: "OK", mergedInto: dstName, commonPrefix: i, entries: state.branches[dstName].entries.length };
  }
  return {
    status: "CONFLICT",
    divergence: {
      index: i,
      src: { branch: srcName, entry: src.entries[i] },
      dst: { branch: dstName, entry: dst.entries[i] },
    },
  };
}

export function sessionSolve(state, opts = {}) {
  const branchName = opts.branch ?? "main";
  const branch = requireBranch(state, branchName);
  const result = solve(effectiveSpec(state), opts);
  const op = { type: "solve", status: result.status };
  if (result.status === "SAT") op.makespan = result.makespan;
  op.certHead = result.certificate.head;
  appendOp(branch, op);
  return result;
}
