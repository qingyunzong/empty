import { canonical, sha256hex, idCompare } from './canonical.js';

export const E_CYCLE = 'E_CYCLE';
export const E_NOT_FOUND = 'E_NOT_FOUND';
export const E_INVALID_OP = 'E_INVALID_OP';
export const E_UNKNOWN_OP = 'E_UNKNOWN_OP';

export class CycleError extends Error {
  constructor(message) {
    super(message);
    this.code = E_CYCLE;
  }
}

function refKey(ref) {
  return ref.kind + ':' + String(ref.id);
}

function normalizeRefs(refs) {
  const seen = new Map();
  for (const ref of refs) {
    if (!ref || (ref.kind !== 'study' && ref.kind !== 'hypothesis')) {
      throw new Error('invalid ref: ' + canonical(ref));
    }
    seen.set(refKey(ref), { kind: ref.kind, id: ref.id });
  }
  return [...seen.values()];
}

export class Engine {
  constructor() {
    this.studies = new Map(); // id -> { weight, effect, active }
    this.hypotheses = new Map(); // id -> { combinator: 'all'|'any', refs: [{kind,id}] }
    this.cache = new Map(); // hypothesisId -> { usable, studies, included, score, excluded }
    this._revStudy = new Map(); // studyId -> Set<hypothesisId>
    this._revHyp = new Map(); // hypothesisId -> Set<hypothesisId> (dependents)
    this.ranking = []; // [{ id, score, rank }] sorted, included only
    this.excluded = []; // sorted hypothesis ids with no valid studies
  }

  // ---- pure resolution over current maps ----

  _resolveRef(ref, visiting) {
    if (ref.kind === 'study') {
      const study = this.studies.get(ref.id);
      if (study && study.active) {
        return { usable: true, studies: new Set([ref.id]) };
      }
      return { usable: false, studies: new Set() };
    }
    return this._resolveHypothesis(ref.id, visiting);
  }

  _resolveHypothesis(hid, visiting) {
    if (visiting.has(hid)) {
      throw new CycleError('cycle detected at hypothesis ' + String(hid));
    }
    const hyp = this.hypotheses.get(hid);
    if (!hyp) return { usable: false, studies: new Set() };
    visiting.add(hid);
    const parts = hyp.refs.map((ref) => this._resolveRef(ref, visiting));
    visiting.delete(hid);
    if (parts.length === 0) return { usable: false, studies: new Set() };
    const studies = new Set();
    if (hyp.combinator === 'all') {
      const usable = parts.every((part) => part.usable);
      if (usable) for (const part of parts) for (const id of part.studies) studies.add(id);
      return { usable, studies };
    }
    // 'any'
    const usable = parts.some((part) => part.usable);
    if (usable) for (const part of parts) for (const id of part.studies) studies.add(id);
    return { usable, studies };
  }

  _finalize(hid, resolved) {
    // Valid evidence: available studies with weight > 0. Zero-weight studies are ignored.
    const included = [...resolved.studies]
      .filter((sid) => this.studies.get(sid).weight > 0)
      .sort(idCompare);
    let sumW = 0;
    let sumWE = 0;
    for (const sid of included) {
      const study = this.studies.get(sid);
      sumW += study.weight;
      sumWE += study.weight * study.effect;
    }
    const score = included.length > 0 ? sumWE / sumW : null;
    const excluded = !resolved.usable || included.length === 0;
    this.cache.set(hid, {
      usable: resolved.usable,
      studies: resolved.studies,
      included,
      score,
      excluded,
    });
  }

  // ---- dependency tracking ----

  _rebuildReverse() {
    this._revStudy = new Map();
    this._revHyp = new Map();
    for (const [hid, hyp] of this.hypotheses) {
      for (const ref of hyp.refs) {
        const map = ref.kind === 'study' ? this._revStudy : this._revHyp;
        if (!map.has(ref.id)) map.set(ref.id, new Set());
        map.get(ref.id).add(hid);
      }
    }
  }

  _affectedFrom(startIds) {
    const affected = new Set(startIds);
    const queue = [...startIds];
    while (queue.length > 0) {
      const id = queue.shift();
      const dependents = this._revHyp.get(id);
      if (!dependents) continue;
      for (const dep of dependents) {
        if (!affected.has(dep)) {
          affected.add(dep);
          queue.push(dep);
        }
      }
    }
    return affected;
  }

  _recompute(affected) {
    for (const hid of affected) {
      if (this.hypotheses.has(hid)) {
        this._finalize(hid, this._resolveHypothesis(hid, new Set()));
      } else {
        this.cache.delete(hid);
      }
    }
    this._rebuildRanking();
  }

  _rebuildRanking() {
    const entries = [];
    const excluded = [];
    for (const [hid, cached] of this.cache) {
      if (cached.excluded) excluded.push(hid);
      else entries.push({ id: hid, score: cached.score });
    }
    entries.sort((a, b) => (b.score - a.score) || idCompare(a.id, b.id));
    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });
    excluded.sort(idCompare);
    this.ranking = entries;
    this.excluded = excluded;
  }

  _wouldCycle(hid) {
    // DFS from hid over hypothesis-only edges; cycle if we can return to hid.
    const stack = [hid];
    const seen = new Set();
    while (stack.length > 0) {
      const current = stack.pop();
      const hyp = this.hypotheses.get(current);
      if (!hyp) continue;
      for (const ref of hyp.refs) {
        if (ref.kind !== 'hypothesis') continue;
        if (ref.id === hid) return true;
        if (!seen.has(ref.id)) {
          seen.add(ref.id);
          stack.push(ref.id);
        }
      }
    }
    return false;
  }

  // ---- mutations (each returns { ok: true, affected } or { error }) ----

  setStudy(id, { weight, effect, active = true }) {
    if (typeof weight !== 'number' || typeof effect !== 'number' ||
        !Number.isFinite(weight) || !Number.isFinite(effect)) {
      return { error: E_INVALID_OP, message: 'weight and effect must be finite numbers' };
    }
    this.studies.set(id, { weight, effect, active: active !== false });
    const affected = this._affectedFrom(this._revStudy.get(id) ?? new Set());
    this._recompute(affected);
    return { ok: true, affected: [...affected].sort(idCompare) };
  }

  retractStudy(id) {
    const study = this.studies.get(id);
    if (!study) return { error: E_NOT_FOUND, message: 'unknown study ' + String(id) };
    study.active = false;
    const affected = this._affectedFrom(this._revStudy.get(id) ?? new Set());
    this._recompute(affected);
    return { ok: true, affected: [...affected].sort(idCompare) };
  }

  correctStudy(id, patch) {
    const study = this.studies.get(id);
    if (!study) return { error: E_NOT_FOUND, message: 'unknown study ' + String(id) };
    const weight = patch.weight ?? study.weight;
    const effect = patch.effect ?? study.effect;
    return this.setStudy(id, { weight, effect, active: patch.active ?? study.active });
  }

  setHypothesis(id, { combinator = 'all', refs = [] }) {
    if (combinator !== 'all' && combinator !== 'any') {
      return { error: E_INVALID_OP, message: 'combinator must be "all" or "any"' };
    }
    let normalized;
    try {
      normalized = normalizeRefs(refs);
    } catch (err) {
      return { error: E_INVALID_OP, message: err.message };
    }
    const previous = this.hypotheses.get(id);
    this.hypotheses.set(id, { combinator, refs: normalized });
    if (this._wouldCycle(id)) {
      if (previous) this.hypotheses.set(id, previous);
      else this.hypotheses.delete(id);
      return { error: E_CYCLE, message: 'reference cycle involving hypothesis ' + String(id) };
    }
    this._rebuildReverse();
    const affected = this._affectedFrom([id]);
    this._recompute(affected);
    return { ok: true, affected: [...affected].sort(idCompare) };
  }

  removeHypothesis(id) {
    if (!this.hypotheses.has(id)) {
      return { error: E_NOT_FOUND, message: 'unknown hypothesis ' + String(id) };
    }
    this.hypotheses.delete(id);
    this._rebuildReverse();
    const affected = this._affectedFrom([id]);
    this._recompute(affected);
    return { ok: true, affected: [...affected].sort(idCompare) };
  }

  addEdge(hypothesisId, ref) {
    const hyp = this.hypotheses.get(hypothesisId);
    if (!hyp) return { error: E_NOT_FOUND, message: 'unknown hypothesis ' + String(hypothesisId) };
    return this.setHypothesis(hypothesisId, {
      combinator: hyp.combinator,
      refs: [...hyp.refs, ref],
    });
  }

  removeEdge(hypothesisId, ref) {
    const hyp = this.hypotheses.get(hypothesisId);
    if (!hyp) return { error: E_NOT_FOUND, message: 'unknown hypothesis ' + String(hypothesisId) };
    const key = refKey(ref);
    return this.setHypothesis(hypothesisId, {
      combinator: hyp.combinator,
      refs: hyp.refs.filter((existing) => refKey(existing) !== key),
    });
  }

  // ---- operation log / deterministic replay ----

  applyOp(op) {
    if (!op || typeof op !== 'object') return { error: E_INVALID_OP };
    switch (op.type) {
      case 'study.upsert':
        return this.setStudy(op.id, { weight: op.weight, effect: op.effect, active: op.active });
      case 'study.retract':
        return this.retractStudy(op.id);
      case 'study.correct':
        return this.correctStudy(op.id, op);
      case 'hypothesis.set':
        return this.setHypothesis(op.id, { combinator: op.combinator, refs: op.refs });
      case 'hypothesis.remove':
        return this.removeHypothesis(op.id);
      case 'edge.add':
        return this.addEdge(op.hypothesis, op.ref);
      case 'edge.remove':
        return this.removeEdge(op.hypothesis, op.ref);
      default:
        return { error: E_UNKNOWN_OP, message: String(op.type) };
    }
  }

  // Deterministic replay: sort by (seq, authorId, canonical op). Ops sharing the
  // same (seq, authorId) are flagged conflict: true but still applied in
  // canonical order, so every replica converges to the same state.
  replay(ops) {
    const decorated = ops.map((op, index) => ({ op, index, key: canonical(op) }));
    decorated.sort((a, b) => {
      const sa = a.op.seq ?? 0;
      const sb = b.op.seq ?? 0;
      if (sa !== sb) return sa - sb;
      const aa = String(a.op.authorId ?? '');
      const ab = String(b.op.authorId ?? '');
      if (aa !== ab) return aa < ab ? -1 : 1;
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return a.index - b.index;
    });
    const seenKeys = new Set();
    const report = [];
    for (const { op } of decorated) {
      const conflictKey = String(op.seq) + '|' + String(op.authorId);
      const conflict = seenKeys.has(conflictKey);
      seenKeys.add(conflictKey);
      const result = this.applyOp(op);
      report.push({
        seq: op.seq ?? null,
        authorId: op.authorId ?? null,
        type: op.type ?? null,
        conflict,
        result,
      });
    }
    return report;
  }

  // ---- read models ----

  rankOf(hid) {
    const entry = this.ranking.find((item) => item.id === hid);
    return entry ? entry.rank : null;
  }

  certificate(hid) {
    const cached = this.cache.get(hid);
    if (!cached) return { error: E_NOT_FOUND, message: 'unknown hypothesis ' + String(hid) };
    const body = {
      hypothesis: hid,
      includedStudies: cached.included,
      score: cached.score,
      rank: this.rankOf(hid),
      excluded: cached.excluded,
    };
    return { ...body, hash: sha256hex(canonical(body)) };
  }

  certificates() {
    return [...this.hypotheses.keys()].sort(idCompare).map((hid) => this.certificate(hid));
  }

  snapshot() {
    return {
      ranking: this.ranking.map((entry) => ({ ...entry })),
      excluded: [...this.excluded],
    };
  }
}

// Minimal rank diff: only hypotheses whose rank or membership changed.
export function rankDiff(before, after) {
  const toMap = (ranking) => new Map(ranking.map((entry) => [entry.id, entry.rank]));
  const a = toMap(before);
  const b = toMap(after);
  const ids = new Set([...a.keys(), ...b.keys()]);
  const changes = [];
  for (const id of ids) {
    const from = a.has(id) ? a.get(id) : null;
    const to = b.has(id) ? b.get(id) : null;
    if (from !== to) changes.push({ id, from, to });
  }
  changes.sort((x, y) => idCompare(x.id, y.id));
  return changes;
}
