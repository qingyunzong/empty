import { canon, sha256 } from "./canon.js";
import { normalizeSpec, specHashOf } from "./spec.js";
import { CERT_FORMAT, specGenesis, checkPlan } from "./solver.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (reason) => ({ status: "INVALID", reason });

export function verify(rawSpec, cert) {
  const norm = normalizeSpec(rawSpec);
  if (!isObj(cert)) return invalid("certificate must be an object");
  if (cert.format !== CERT_FORMAT) return invalid(`unsupported certificate format "${cert.format}"`);
  const specHash = specHashOf(norm);
  if (cert.specHash !== specHash) return invalid("specHash mismatch: certificate was not issued for this spec");
  if (!Array.isArray(cert.entries)) return invalid("certificate entries must be an array");
  if (typeof cert.head !== "string") return invalid("certificate head must be a hash string");

  const n = norm.steps.length;
  const ids = norm.steps.map((s) => s.id);
  const dur = norm.steps.map((s) => s.duration);
  const mem = norm.steps.map((s) => s.memory);
  const M = norm.machines;
  const L = norm.memoryLimit;

  const compatOk = (uIdx, pu, vIdx, pv) => norm.compat.get(ids[uIdx] + ">" + ids[vIdx]).get(pu).includes(pv);
  const overlap = (s1, d1, s2, d2) => s1 < s2 + d2 && s2 < s1 + d1;

  let T = null;
  let assigned = new Array(n).fill(null);
  let memUsed = null;
  let machUsed = null;

  const propagationConflict = () => {
    const EST = new Array(n).fill(0);
    const LST = new Array(n).fill(0);
    for (const u of norm.topo) {
      if (assigned[u]) EST[u] = assigned[u].start;
      else {
        let e = 0;
        for (const p of norm.pred[u]) e = Math.max(e, EST[p] + dur[p]);
        EST[u] = e;
      }
    }
    for (let k = n - 1; k >= 0; k--) {
      const u = norm.topo[k];
      if (assigned[u]) LST[u] = assigned[u].start;
      else {
        let l = T - dur[u];
        for (const v of norm.succ[u]) l = Math.min(l, LST[v] - dur[u]);
        LST[u] = l;
      }
    }
    for (let u = 0; u < n; u++) if (EST[u] > LST[u]) return true;
    const doms = norm.steps.map((s, i) => (assigned[i] ? [assigned[i].param] : [...s.params]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [uu, vv] of norm.edges) {
        const u = norm.index.get(uu);
        const v = norm.index.get(vv);
        for (const dir of [0, 1]) {
          const x = dir === 0 ? u : v;
          const y = dir === 0 ? v : u;
          const kept = doms[x].filter((px) => doms[y].some((py) => (dir === 0 ? compatOk(x, px, y, py) : compatOk(y, py, x, px))));
          if (kept.length === 0) return true;
          if (kept.length < doms[x].length) {
            doms[x] = kept;
            changed = true;
          }
        }
      }
    }
    let needMem = 0;
    let needDur = 0;
    for (let i = 0; i < n; i++) {
      if (assigned[i]) continue;
      needMem += mem[i] * dur[i];
      needDur += dur[i];
    }
    let freeMem = 0;
    let usedMach = 0;
    for (let t = 0; t < T; t++) freeMem += L - memUsed[t];
    for (let m = 0; m < M; m++) for (let t = 0; t < T; t++) if (machUsed[m][t]) usedMach++;
    if (needMem > freeMem) return true;
    if (needDur > M * T - usedMach) return true;
    return false;
  };

  let head = specGenesis(specHash);
  for (let i = 0; i < cert.entries.length; i++) {
    const e = cert.entries[i];
    if (!isObj(e)) return invalid(`entry ${i} must be an object`);
    if (e.i !== i) return invalid(`entry ${i} has wrong sequence index`);
    if (typeof e.hash !== "string") return invalid(`entry ${i} is missing its hash`);
    const { hash: entryHash, ...rest } = e;
    const expect = sha256(head + ":" + canon(rest));
    if (entryHash !== expect) return invalid(`entry ${i} breaks the hash chain`);
    head = entryHash;

    if (e.type === "bound") {
      if (!Number.isInteger(e.T) || e.T < 0) return invalid(`entry ${i} has bad bound`);
      T = e.T;
      assigned = new Array(n).fill(null);
      memUsed = new Array(Math.max(T, 0)).fill(0);
      machUsed = Array.from({ length: M }, () => new Array(Math.max(T, 0)).fill(false));
    } else if (e.type === "decision") {
      if (T === null) return invalid(`entry ${i} decision before any bound`);
      const j = norm.index.get(e.step);
      if (j === undefined) return invalid(`entry ${i} names unknown step "${e.step}"`);
      if (assigned[j]) return invalid(`entry ${i} re-assigns step "${e.step}"`);
      const { start, machine: m, param: p } = e;
      if (!Number.isInteger(start) || !Number.isInteger(m) || typeof p !== "string") {
        return invalid(`entry ${i} has malformed decision value`);
      }
      if (!norm.steps[j].params.includes(p)) return invalid(`entry ${i} param "${p}" not in domain of "${e.step}"`);
      if (m < 0 || m >= M) return invalid(`entry ${i} machine out of range`);
      if (start < 0 || start + dur[j] > T) return invalid(`entry ${i} start outside the time bound`);
      for (const v of norm.succ[j]) {
        if (assigned[v] && start + dur[j] > assigned[v].start) return invalid(`entry ${i} violates edge ${e.step}>${ids[v]}`);
        if (assigned[v] && !compatOk(j, p, v, assigned[v].param)) return invalid(`entry ${i} violates compat ${e.step}>${ids[v]}`);
      }
      for (const u of norm.pred[j]) {
        if (assigned[u] && assigned[u].start + dur[u] > start) return invalid(`entry ${i} violates edge ${ids[u]}>${e.step}`);
        if (assigned[u] && !compatOk(u, assigned[u].param, j, p)) return invalid(`entry ${i} violates compat ${ids[u]}>${e.step}`);
      }
      for (const [a, b] of norm.mutex) {
        const other = a === j ? b : b === j ? a : -1;
        if (other >= 0 && assigned[other] && overlap(start, dur[j], assigned[other].start, dur[other])) {
          return invalid(`entry ${i} violates mutex on step "${e.step}"`);
        }
      }
      for (let t = start; t < start + dur[j]; t++) {
        if (machUsed[m][t]) return invalid(`entry ${i} double-books machine ${m}`);
        if (memUsed[t] + mem[j] > L) return invalid(`entry ${i} exceeds the memory limit`);
      }
      assigned[j] = { start, machine: m, param: p };
      for (let t = start; t < start + dur[j]; t++) {
        machUsed[m][t] = true;
        memUsed[t] += mem[j];
      }
    } else if (e.type === "backtrack") {
      const j = norm.index.get(e.step);
      if (j === undefined) return invalid(`entry ${i} names unknown step "${e.step}"`);
      if (!assigned[j]) return invalid(`entry ${i} backtracks unassigned step "${e.step}"`);
      const a = assigned[j];
      for (let t = a.start; t < a.start + dur[j]; t++) {
        machUsed[a.machine][t] = false;
        memUsed[t] -= mem[j];
      }
      assigned[j] = null;
    } else if (e.type === "propagate") {
      if (e.reason === "memory-capacity") {
        const j = norm.index.get(e.step);
        if (j === undefined) return invalid(`entry ${i} names unknown step "${e.step}"`);
        if (mem[j] <= L) return invalid(`entry ${i} claims a memory-capacity conflict that does not exist`);
      } else if (e.conflict === true) {
        if (T === null) return invalid(`entry ${i} conflict before any bound`);
        if (!propagationConflict()) return invalid(`entry ${i} claims a propagation conflict that does not reproduce`);
      }
    } else {
      return invalid(`entry ${i} has unknown type "${e.type}"`);
    }
  }
  if (head !== cert.head) return invalid("certificate head does not match the recomputed hash chain");

  const result = cert.result;
  if (!isObj(result) || typeof result.status !== "string") return invalid("certificate result is malformed");
  if (result.status === "SAT") {
    for (let i = 0; i < n; i++) {
      if (!assigned[i]) return invalid(`SAT result but step "${ids[i]}" was never assigned`);
    }
    const plan = {};
    for (let i = 0; i < n; i++) plan[ids[i]] = assigned[i];
    const planErr = checkPlan(norm, plan);
    if (planErr) return invalid(`replayed plan is infeasible: ${planErr}`);
    const makespan = Math.max(...assigned.map((a, i) => a.start + dur[i]));
    if (result.makespan !== makespan) return invalid("claimed makespan does not match the replayed plan");
    if (canon(result.plan) !== canon(plan)) return invalid("claimed plan does not match the replayed decisions");
    return { status: "VERIFIED", result: "SAT", makespan };
  }
  if (result.status === "UNSAT" || result.status === "PENDING") {
    if (assigned.every(Boolean)) {
      return invalid(`certificate claims ${result.status} but its trace ends in a complete SAT plan`);
    }
    return { status: "VERIFIED", result: result.status };
  }
  return invalid(`unknown result status "${result.status}"`);
}
