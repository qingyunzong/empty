import { createHash } from 'node:crypto';

export const ERR = Object.freeze({
  CYCLE: 'E_CYCLE',
  SEQ_CONFLICT: 'E_SEQ_CONFLICT',
  NOT_FOUND: 'E_NOT_FOUND',
  DUPLICATE: 'E_DUPLICATE',
  INVALID: 'E_INVALID',
});

export class EvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class CycleError extends Error {
  constructor(cycle) {
    super(`reference cycle detected: ${[...cycle, cycle[0]].join(' -> ')}`);
    this.code = ERR.CYCLE;
    this.cycle = cycle;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function isValidId(id) {
  return typeof id === 'string' && id.length > 0;
}

function assertId(id, what) {
  if (!isValidId(id)) throw new EvidenceError(ERR.INVALID, `${what} id must be a non-empty string`);
}

function assertWeight(weight) {
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
    throw new EvidenceError(ERR.INVALID, `weight must be a finite number >= 0, got ${weight}`);
  }
}

function assertEffect(effect) {
  if (typeof effect !== 'number' || !Number.isFinite(effect)) {
    throw new EvidenceError(ERR.INVALID, `effect must be a finite number, got ${effect}`);
  }
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function unionStudies(refResults) {
  const out = new Set();
  for (const r of refResults) for (const sid of r.studies) out.add(sid);
  return out;
}

function diffSnapshots(before, after) {
  const diff = [];
  for (const [id, to] of after) {
    const from = before.has(id) ? before.get(id) : null;
    if (from !== to) diff.push({ id, from, to });
  }
  for (const [id, from] of before) {
    if (!after.has(id)) diff.push({ id, from, to: null });
  }
  return diff.sort((a, b) => compareIds(a.id, b.id));
}

export class EvidenceGraph {
  constructor() {
    this.studies = new Map(); // id -> { id, weight, effect, active }
    this.claims = new Map(); // id -> { id, op: 'all'|'any', refs: [] }
    this.dependents = new Map(); // nodeId -> Set<claimId> referencing it
    this._cache = new Map(); // claimId -> evaluation result
    this._ranking = []; // [{ id, score, rank }]
    this._excluded = []; // [{ id, status, reason }]
  }

  addStudy(id, { weight = 1, effect = 0 } = {}) {
    assertId(id, 'study');
    assertWeight(weight);
    assertEffect(effect);
    if (this.studies.has(id) || this.claims.has(id)) {
      throw new EvidenceError(ERR.DUPLICATE, `node ${id} already exists`);
    }
    this.studies.set(id, { id, weight, effect, active: true });
    return this._afterMutation([id]);
  }

  removeStudy(id) {
    if (!this.studies.has(id)) throw new EvidenceError(ERR.NOT_FOUND, `study ${id} not found`);
    this.studies.delete(id);
    return this._afterMutation([id]);
  }

  retractStudy(id) {
    return this._setActive(id, false);
  }

  restoreStudy(id) {
    return this._setActive(id, true);
  }

  _setActive(id, active) {
    const study = this.studies.get(id);
    if (!study) throw new EvidenceError(ERR.NOT_FOUND, `study ${id} not found`);
    if (study.active === active) return { affected: [], rankingDiff: [] };
    study.active = active;
    return this._afterMutation([id]);
  }

  setWeight(id, weight) {
    assertWeight(weight);
    const study = this.studies.get(id);
    if (!study) throw new EvidenceError(ERR.NOT_FOUND, `study ${id} not found`);
    if (study.weight === weight) return { affected: [], rankingDiff: [] };
    study.weight = weight;
    return this._afterMutation([id]);
  }

  setEffect(id, effect) {
    assertEffect(effect);
    const study = this.studies.get(id);
    if (!study) throw new EvidenceError(ERR.NOT_FOUND, `study ${id} not found`);
    if (study.effect === effect) return { affected: [], rankingDiff: [] };
    study.effect = effect;
    return this._afterMutation([id]);
  }

  addClaim(id, { op = 'any', refs = [] } = {}) {
    assertId(id, 'claim');
    if (op !== 'all' && op !== 'any') {
      throw new EvidenceError(ERR.INVALID, `op must be "all" or "any", got ${op}`);
    }
    if (!Array.isArray(refs) || refs.some((r) => !isValidId(r))) {
      throw new EvidenceError(ERR.INVALID, 'refs must be an array of non-empty strings');
    }
    if (new Set(refs).size !== refs.length) {
      throw new EvidenceError(ERR.DUPLICATE, `duplicate refs in claim ${id}`);
    }
    if (this.claims.has(id) || this.studies.has(id)) {
      throw new EvidenceError(ERR.DUPLICATE, `node ${id} already exists`);
    }
    this.claims.set(id, { id, op, refs: [...refs] });
    for (const ref of refs) this._dependentsOf(ref).add(id);
    return this._afterMutation([id]);
  }

  removeClaim(id) {
    const claim = this.claims.get(id);
    if (!claim) throw new EvidenceError(ERR.NOT_FOUND, `claim ${id} not found`);
    for (const ref of claim.refs) this.dependents.get(ref)?.delete(id);
    this.claims.delete(id);
    this._cache.delete(id);
    return this._afterMutation([id]);
  }

  addEdge(claimId, refId) {
    const claim = this.claims.get(claimId);
    if (!claim) throw new EvidenceError(ERR.NOT_FOUND, `claim ${claimId} not found`);
    assertId(refId, 'ref');
    if (claim.refs.includes(refId)) {
      throw new EvidenceError(ERR.DUPLICATE, `edge ${claimId} -> ${refId} already exists`);
    }
    claim.refs.push(refId);
    this._dependentsOf(refId).add(claimId);
    return this._afterMutation([claimId]);
  }

  removeEdge(claimId, refId) {
    const claim = this.claims.get(claimId);
    if (!claim) throw new EvidenceError(ERR.NOT_FOUND, `claim ${claimId} not found`);
    const idx = claim.refs.indexOf(refId);
    if (idx === -1) {
      throw new EvidenceError(ERR.NOT_FOUND, `edge ${claimId} -> ${refId} not found`);
    }
    claim.refs.splice(idx, 1);
    this.dependents.get(refId)?.delete(claimId);
    return this._afterMutation([claimId]);
  }

  apply(op) {
    if (!op || typeof op !== 'object') {
      throw new EvidenceError(ERR.INVALID, 'operation must be an object');
    }
    switch (op.type) {
      case 'add_study': return this.addStudy(op.id, { weight: op.weight ?? 1, effect: op.effect ?? 0 });
      case 'remove_study': return this.removeStudy(op.id);
      case 'retract_study': return this.retractStudy(op.id);
      case 'restore_study': return this.restoreStudy(op.id);
      case 'set_weight': return this.setWeight(op.id, op.weight);
      case 'set_effect': return this.setEffect(op.id, op.effect);
      case 'add_claim': return this.addClaim(op.id, { op: op.op ?? 'any', refs: op.refs ?? [] });
      case 'remove_claim': return this.removeClaim(op.id);
      case 'add_edge': return this.addEdge(op.claim, op.ref);
      case 'remove_edge': return this.removeEdge(op.claim, op.ref);
      default: throw new EvidenceError(ERR.INVALID, `unknown operation type: ${op.type}`);
    }
  }

  // Replays history deterministically ordered by (seq, authorId).
  // A duplicate (seq, authorId) pair is a conflict: nothing is applied.
  replay(ops) {
    if (!Array.isArray(ops)) {
      return { ok: false, applied: 0, errors: [{ code: ERR.INVALID, message: 'operations must be an array' }], diffs: [] };
    }
    for (const op of ops) {
      if (!op || typeof op.seq !== 'number' || !Number.isFinite(op.seq) || !isValidId(op.authorId)) {
        return { ok: false, applied: 0, errors: [{ code: ERR.INVALID, message: 'every operation needs a numeric seq and a string authorId' }], diffs: [] };
      }
    }
    const seen = new Set();
    for (const op of ops) {
      const key = `${op.seq} ${op.authorId}`;
      if (seen.has(key)) {
        return {
          ok: false,
          applied: 0,
          errors: [{ code: ERR.SEQ_CONFLICT, seq: op.seq, authorId: op.authorId, message: `conflicting operations at (seq=${op.seq}, authorId=${op.authorId})` }],
          diffs: [],
        };
      }
      seen.add(key);
    }
    const sorted = [...ops].sort((a, b) => a.seq - b.seq || compareIds(a.authorId, b.authorId));
    const diffs = [];
    const errors = [];
    let applied = 0;
    for (const op of sorted) {
      try {
        const diff = this.apply(op);
        applied += 1;
        diffs.push({ seq: op.seq, authorId: op.authorId, type: op.type, ...diff });
      } catch (e) {
        errors.push({ seq: op.seq, authorId: op.authorId, type: op.type, code: e.code ?? ERR.INVALID, message: e.message });
      }
    }
    return { ok: errors.length === 0, applied, errors, diffs };
  }

  getRanking() {
    return this._ranking.map((r) => ({ ...r }));
  }

  getExcluded() {
    return this._excluded.map((e) => ({ ...e }));
  }

  evaluate(id) {
    if (!this.claims.has(id)) throw new EvidenceError(ERR.NOT_FOUND, `claim ${id} not found`);
    const res = this._evalTop(id);
    return { id, ...res, studies: [...(res.studies ?? [])] };
  }

  getCertificate(id) {
    if (!this.claims.has(id)) throw new EvidenceError(ERR.NOT_FOUND, `claim ${id} not found`);
    const res = this._evalTop(id);
    const entry = this._ranking.find((r) => r.id === id);
    const cert = {
      hypothesisId: id,
      status: res.status,
      studies: res.studies ?? [],
      score: res.status === 'ok' ? res.score : null,
      rank: entry ? entry.rank : null,
    };
    if (res.status === 'excluded') cert.reason = res.reason;
    if (res.status === 'error') cert.error = res.code;
    cert.hash = createHash('sha256').update(canonical(cert)).digest('hex');
    return cert;
  }

  _dependentsOf(nodeId) {
    let set = this.dependents.get(nodeId);
    if (!set) {
      set = new Set();
      this.dependents.set(nodeId, set);
    }
    return set;
  }

  _afterMutation(sources) {
    const affected = new Set();
    const queue = [];
    for (const s of sources) {
      if (this.claims.has(s)) affected.add(s);
      queue.push(s);
    }
    while (queue.length > 0) {
      const nodeId = queue.pop();
      for (const claimId of this.dependents.get(nodeId) ?? []) {
        if (!affected.has(claimId)) {
          affected.add(claimId);
          queue.push(claimId);
        }
      }
    }
    const before = this._rankSnapshot();
    for (const claimId of affected) this._cache.delete(claimId);
    for (const claimId of affected) {
      if (this.claims.has(claimId)) this._evalTop(claimId);
    }
    this._rebuildRanking();
    const after = this._rankSnapshot();
    return { affected: [...affected].sort(), rankingDiff: diffSnapshots(before, after) };
  }

  _evalTop(id) {
    try {
      return this._eval(id, []);
    } catch (e) {
      if (e instanceof CycleError) {
        const cached = this._cache.get(id);
        if (cached) return cached;
        return { status: 'error', code: ERR.CYCLE, cycle: [...e.cycle], studies: [], score: null };
      }
      throw e;
    }
  }

  _eval(id, stack) {
    const cached = this._cache.get(id);
    if (cached) return cached;
    const cycleStart = stack.indexOf(id);
    if (cycleStart !== -1) throw new CycleError(stack.slice(cycleStart));
    const claim = this.claims.get(id);
    if (!claim) return { status: 'missing', studies: [], score: null };
    const nextStack = [...stack, id];
    const refResults = [];
    for (const ref of claim.refs) {
      if (this.studies.has(ref)) {
        const study = this.studies.get(ref);
        refResults.push({ available: study.active, studies: study.active ? [ref] : [] });
      } else if (this.claims.has(ref)) {
        let sub;
        try {
          sub = this._eval(ref, nextStack);
        } catch (e) {
          if (e instanceof CycleError) {
            if (e.cycle.includes(id)) {
              const errRes = { status: 'error', code: ERR.CYCLE, cycle: [...e.cycle], studies: [], score: null };
              this._cache.set(id, errRes);
              throw e;
            }
            sub = { status: 'error' };
          } else {
            throw e;
          }
        }
        refResults.push({ available: sub.status === 'ok', studies: sub.status === 'ok' ? sub.studies : [] });
      } else {
        refResults.push({ available: false, studies: [] });
      }
    }
    let included;
    if (claim.op === 'all') {
      const allAvailable = claim.refs.length > 0 && refResults.every((r) => r.available);
      included = allAvailable ? unionStudies(refResults) : new Set();
    } else {
      included = unionStudies(refResults.filter((r) => r.available));
    }
    let result;
    if (included.size === 0) {
      result = { status: 'excluded', reason: 'no_valid_studies', studies: [], score: null };
    } else {
      let weightSum = 0;
      let weightedSum = 0;
      for (const sid of included) {
        const study = this.studies.get(sid);
        weightSum += study.weight;
        weightedSum += study.weight * study.effect;
      }
      if (weightSum === 0) {
        result = { status: 'excluded', reason: 'zero_total_weight', studies: [...included].sort(), score: null };
      } else {
        result = { status: 'ok', studies: [...included].sort(), score: weightedSum / weightSum };
      }
    }
    this._cache.set(id, result);
    return result;
  }

  _rebuildRanking() {
    const ok = [];
    const excluded = [];
    for (const id of this.claims.keys()) {
      const res = this._cache.get(id) ?? this._evalTop(id);
      if (res.status === 'ok') {
        ok.push({ id, score: res.score });
      } else {
        excluded.push({ id, status: res.status, reason: res.reason ?? res.code ?? null });
      }
    }
    ok.sort((a, b) => b.score - a.score || compareIds(a.id, b.id));
    this._ranking = ok.map((e, i) => ({ id: e.id, score: e.score, rank: i + 1 }));
    this._excluded = excluded.sort((a, b) => compareIds(a.id, b.id));
  }

  _rankSnapshot() {
    const map = new Map();
    for (const r of this._ranking) map.set(r.id, r.rank);
    for (const e of this._excluded) if (!map.has(e.id)) map.set(e.id, null);
    return map;
  }
}
