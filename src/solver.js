import { canon, sha256 } from "./canon.js";
import { normalizeSpec, specHashOf } from "./spec.js";

export class BudgetExhausted extends Error {
  constructor() {
    super("budget exhausted");
    this.name = "BudgetExhausted";
  }
}

export const CERT_FORMAT = "repro-cert/1";

export function specGenesis(specHash) {
  return sha256(`${CERT_FORMAT}:${specHash}`);
}

export class CertBuilder {
  constructor(specHash, maxBytes = Infinity) {
    this.specHash = specHash;
    this.entries = [];
    this.head = specGenesis(specHash);
    this.maxBytes = maxBytes;
    this.bytes = 128;
    this.exhausted = false;
  }

  add(entry) {
    if (this.exhausted) return false;
    const e = { i: this.entries.length, ...entry };
    const h = sha256(this.head + ":" + canon(e));
    e.hash = h;
    const size = Buffer.byteLength(JSON.stringify(e)) + 1;
    if (this.bytes + size > this.maxBytes) {
      this.exhausted = true;
      return false;
    }
    this.entries.push(e);
    this.head = h;
    this.bytes += size;
    return true;
  }

  build(result) {
    return { format: CERT_FORMAT, specHash: this.specHash, entries: this.entries, head: this.head, result };
  }
}

export function solve(rawSpec, opts = {}) {
  const norm = normalizeSpec(rawSpec);
  const maxNodes = opts.maxNodes ?? Infinity;
  const maxCertBytes = opts.maxCertBytes ?? Infinity;
  const cert = new CertBuilder(specHashOf(norm), maxCertBytes);
  const n = norm.steps.length;
  const M = norm.machines;
  const L = norm.memoryLimit;
  const dur = norm.steps.map((s) => s.duration);
  const mem = norm.steps.map((s) => s.memory);
  const domains0 = norm.steps.map((s) => [...s.params]);
  const ids = norm.steps.map((s) => s.id);
  const energy = norm.steps.reduce((a, s) => a + s.duration * s.memory, 0);

  const addOrThrow = (entry) => {
    if (!cert.add(entry)) throw new BudgetExhausted();
  };

  for (let i = 0; i < n; i++) {
    if (mem[i] > L) {
      cert.add({ type: "propagate", reason: "memory-capacity", step: ids[i] });
      const result = { status: "UNSAT", reason: `step "${ids[i]}" memory ${mem[i]} exceeds memoryLimit ${L}` };
      return { status: "UNSAT", certificate: cert.build(result), stats: { nodes: 0 } };
    }
  }

  const compatOk = (uIdx, pu, vIdx, pv) => {
    const row = norm.compat.get(ids[uIdx] + ">" + ids[vIdx]);
    return row.get(pu).includes(pv);
  };
  const overlap = (s1, d1, s2, d2) => s1 < s2 + d2 && s2 < s1 + d1;
  const edgeIdx = norm.edges.map(([u, v]) => [norm.index.get(u), norm.index.get(v)]);

  const ac3 = (domains) => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [u, v] of edgeIdx) {
        for (const dir of [0, 1]) {
          const x = dir === 0 ? u : v;
          const y = dir === 0 ? v : u;
          const ok = dir === 0 ? (px, py) => compatOk(u, px, v, py) : (px, py) => compatOk(u, py, v, px);
          const kept = domains[x].filter((px) => domains[y].some((py) => ok(px, py)));
          if (kept.length === 0) return { reason: "compat", step: ids[x] };
          if (kept.length < domains[x].length) {
            domains[x] = kept;
            changed = true;
          }
        }
      }
    }
    return null;
  };

  const memIncompat = (i, j) => mem[i] + mem[j] > L;
  const clique = [];
 let nodes = 0;
  {
    const order = norm.steps.map((_, i) => i).sort((a, b) => mem[b] - mem[a] || a - b);
    for (const i of order) {
      const clashes = (j) => memIncompat(i, j) || norm.mutex.some(([a, b]) => (a === i && b === j) || (a === j && b === i));
      if (clique.every((j) => clashes(j))) clique.push(i);
    }
  }
  const cliqueDur = clique.reduce((a, i) => a + dur[i], 0);
  const lb = Math.max(norm.critPath, Math.ceil(norm.totalDur / M), Math.ceil(energy / Math.max(L, 1)), cliqueDur);
  const ub = norm.totalDur;

  const search = (T) => {
    const assigned = new Array(n).fill(null);
    const memUsed = new Array(T).fill(0);
    const machUsed = Array.from({ length: M }, () => new Array(T).fill(false));
    const machJobs = new Array(M).fill(0);
    let machinesInUse = 0;
    let EST = new Array(n).fill(0);
    let LST = new Array(n).fill(0);
    let domains = domains0.map((d) => [...d]);

    const propagate = () => {
      for (const u of norm.topo) {
        if (assigned[u]) {
          EST[u] = assigned[u].start;
        } else {
          let e = 0;
          for (const p of norm.pred[u]) e = Math.max(e, EST[p] + dur[p]);
          EST[u] = e;
        }
      }
      for (let k = n - 1; k >= 0; k--) {
        const u = norm.topo[k];
        if (assigned[u]) {
          LST[u] = assigned[u].start;
        } else {
          let l = T - dur[u];
          for (const v of norm.succ[u]) l = Math.min(l, LST[v] - dur[u]);
          LST[u] = l;
        }
      }
      for (let u = 0; u < n; u++) {
        if (EST[u] > LST[u]) return { reason: "window", step: ids[u] };
      }
      for (let i = 0; i < n; i++) {
        domains[i] = assigned[i] ? [assigned[i].param] : [...domains0[i]];
      }
      const acConflict = ac3(domains);
      if (acConflict) return acConflict;
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
      if (needMem > freeMem) return { reason: "memory-energy", step: null };
      if (needDur > M * T - usedMach) return { reason: "machine-capacity", step: null };
      return null;
    };

    const fits = (j, start, m, p) => {
      for (const v of norm.succ[j]) {
        if (assigned[v] && start + dur[j] > assigned[v].start) return false;
        if (assigned[v] && !compatOk(j, p, v, assigned[v].param)) return false;
      }
      for (const u of norm.pred[j]) {
        if (assigned[u] && assigned[u].start + dur[u] > start) return false;
        if (assigned[u] && !compatOk(u, assigned[u].param, j, p)) return false;
      }
      for (const [a, b] of norm.mutex) {
        const other = a === j ? b : b === j ? a : -1;
        if (other >= 0 && assigned[other] && overlap(start, dur[j], assigned[other].start, dur[other])) return false;
      }
      for (let t = start; t < start + dur[j]; t++) {
        if (machUsed[m][t]) return false;
        if (memUsed[t] + mem[j] > L) return false;
      }
      return true;
    };

    const place = (j, start, m, p) => {
      assigned[j] = { start, machine: m, param: p };
      if (machJobs[m] === 0) machinesInUse++;
      machJobs[m]++;
      for (let t = start; t < start + dur[j]; t++) {
        machUsed[m][t] = true;
        memUsed[t] += mem[j];
      }
    };
    const unplace = (j) => {
      const a = assigned[j];
      machJobs[a.machine]--;
      if (machJobs[a.machine] === 0) machinesInUse--;
      for (let t = a.start; t < a.start + dur[j]; t++) {
        machUsed[a.machine][t] = false;
        memUsed[t] -= mem[j];
      }
      assigned[j] = null;
    };

    const dfs = () => {
      const conflict = propagate();
      if (conflict) {
        addOrThrow({ type: "propagate", conflict: true, reason: conflict.reason, step: conflict.step ?? null });
        return false;
      }
      let j = -1;
      for (let i = 0; i < n; i++) {
        if (!assigned[i]) {
          j = i;
          break;
        }
      }
      if (j === -1) return true;
      const est = EST[j];
      const lst = LST[j];
      const dom = domains[j];
      const mLimit = Math.min(machinesInUse, M - 1);
      for (let start = est; start <= lst; start++) {
        for (let m = 0; m <= mLimit; m++) {
          for (const p of dom) {
            if (++nodes > maxNodes) throw new BudgetExhausted();
            if (!fits(j, start, m, p)) continue;
            addOrThrow({ type: "decision", step: ids[j], start, machine: m, param: p });
            place(j, start, m, p);
            if (dfs()) return true;
            unplace(j);
            addOrThrow({ type: "backtrack", step: ids[j] });
          }
        }
      }
      return false;
    };

    if (dfs()) {
      const plan = [];
      for (let i = 0; i < n; i++) plan.push({ ...assigned[i] });
      return plan;
    }
    return null;
  };

  try {
    for (let T = lb; T <= ub; T++) {
      if (energy > L * T) {
        addOrThrow({ type: "bound", T, skipped: "energy-bound" });
        continue;
      }
      addOrThrow({ type: "bound", T });
      const plan = search(T);
      if (plan) {
        const planObj = {};
        for (let i = 0; i < n; i++) planObj[ids[i]] = plan[i];
        const result = { status: "SAT", makespan: T, plan: planObj };
        return { status: "SAT", makespan: T, plan: planObj, certificate: cert.build(result), stats: { nodes } };
      }
    }
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      return { status: "PENDING", certificate: cert.build({ status: "PENDING" }), stats: { nodes } };
    }
    throw e;
  }
  return { status: "UNSAT", certificate: cert.build({ status: "UNSAT" }), stats: { nodes } };
}

export function planEncoding(plan) {
  const ids = Object.keys(plan).sort();
  return ids.map((id) => [plan[id].start, plan[id].machine, plan[id].param]);
}

export function comparePlans(a, b) {
  const ea = planEncoding(a);
  const eb = planEncoding(b);
  for (let i = 0; i < ea.length; i++) {
    for (let k = 0; k < 3; k++) {
      const x = ea[i][k];
      const y = eb[i][k];
      if (x === y) continue;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function checkPlan(norm, plan) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return "plan must be an object";
  const n = norm.steps.length;
  const ids = norm.steps.map((s) => s.id);
  for (const id of Object.keys(plan)) {
    if (!norm.index.has(id)) return `plan contains unknown step "${id}"`;
  }
  const A = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = plan[ids[i]];
    if (a === null || typeof a !== "object") return `plan missing step "${ids[i]}"`;
    const { start, machine, param } = a;
    if (!Number.isInteger(start) || start < 0) return `step "${ids[i]}" has bad start`;
    if (!Number.isInteger(machine) || machine < 0 || machine >= norm.machines) return `step "${ids[i]}" has bad machine`;
    if (!norm.steps[i].params.includes(param)) return `step "${ids[i]}" param "${param}" not in domain`;
    A[i] = { start, machine, param };
  }
  for (const [u, v] of norm.edges) {
    const iu = norm.index.get(u);
    const iv = norm.index.get(v);
    if (A[iu].start + norm.steps[iu].duration > A[iv].start) {
      return `edge ${u}>${v} violated: successor starts before predecessor ends`;
    }
    const row = norm.compat.get(u + ">" + v);
    if (!row.get(A[iu].param).includes(A[iv].param)) {
      return `compat ${u}>${v} violated for params ${A[iu].param} -> ${A[iv].param}`;
    }
  }
  const overlap = (s1, d1, s2, d2) => s1 < s2 + d2 && s2 < s1 + d1;
  for (const [a, b] of norm.mutex) {
    if (overlap(A[a].start, norm.steps[a].duration, A[b].start, norm.steps[b].duration)) {
      return `mutex pair ${ids[a]} / ${ids[b]} overlaps in time`;
    }
  }
  const makespan = Math.max(...A.map((a, i) => a.start + norm.steps[i].duration));
  const machUsed = Array.from({ length: norm.machines }, () => new Array(makespan).fill(false));
  const memUsed = new Array(makespan).fill(0);
  for (let i = 0; i < n; i++) {
    for (let t = A[i].start; t < A[i].start + norm.steps[i].duration; t++) {
      if (machUsed[A[i].machine][t]) return `machine ${A[i].machine} double-booked at slot ${t}`;
      machUsed[A[i].machine][t] = true;
      memUsed[t] += norm.steps[i].memory;
      if (memUsed[t] > norm.memoryLimit) return `memory peak exceeded at slot ${t}`;
    }
  }
  return null;
}
