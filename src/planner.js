import { tokenize } from './tokenize.js';
import { PositionalIndex } from './index.js';
import { verifyTokens } from './verify.js';
import { selectOptimal } from './select.js';
import { PlannerError, E_LIMIT } from './errors.js';

export const PHRASE = '低温 固化';
export const MAX_DISTANCE = 6;
// Exact subset enumeration is exponential; cap candidates to keep it safe.
export const MAX_CANDIDATES = 20;

export class Planner {
  constructor(store) {
    this.store = store;
    this.index = new PositionalIndex();
    for (const job of store.jobs.values()) {
      this.index.add(job.id, 'description', tokenize(job.description));
    }
  }

  // Full evidence for one job: inverted-index view + independent scan.
  evaluate(job) {
    const tokens = tokenize(job.description);
    const scan = verifyTokens(tokens, {
      phrase: PHRASE,
      material: job.material,
      equipment: job.equipment,
      maxDistance: MAX_DISTANCE,
    });
    const terms = [...new Set([...tokenize(PHRASE), job.material, job.equipment])];
    const indexTerms = {};
    for (const term of terms) {
      indexTerms[term] = this.index.positions('description', term, job.id);
    }
    const indexCandidate = terms.every((t) => indexTerms[t].length > 0);
    const hits = scan.hits;
    const score = hits * 10 - job.overdue;
    return { job, scan, indexTerms, indexCandidate, hits, score };
  }

  // Candidates are produced by the inverted index (term postings
  // intersection), voided jobs are filtered out, then each candidate is
  // precisely verified by the independent linear scan.
  candidates() {
    const phraseTerms = [...new Set(tokenize(PHRASE))];
    let idSet = null;
    for (const term of phraseTerms) {
      const ids = new Set(this.index.postings('description', term).keys());
      idSet = idSet === null ? ids : new Set([...idSet].filter((x) => ids.has(x)));
    }
    const out = [];
    for (const id of idSet) {
      const job = this.store.jobs.get(id);
      if (job.voided) continue;
      if (!this.index.postings('description', job.material).has(id)) continue;
      if (!this.index.postings('description', job.equipment).has(id)) continue;
      const ev = this.evaluate(job);
      if (ev.scan.matched) out.push(ev);
    }
    out.sort((a, b) => (a.job.id < b.job.id ? -1 : 1));
    return out;
  }

  // select({k, budget}) -> {status, optima}
  //   status: EMPTY (no candidates) | OVER_BUDGET (candidates exist but
  //           nothing affordable) | OK (unique optimum) | TIE (>1 optima,
  //           all returned)
  select({ k, budget }) {
    if (!Number.isInteger(k) || k < 1) {
      throw new PlannerError(E_LIMIT, `select: k must be a positive integer, got ${k}`);
    }
    if (!Number.isInteger(budget) || budget < 0) {
      throw new PlannerError(E_LIMIT, `select: budget must be a non-negative integer, got ${budget}`);
    }
    const cands = this.candidates();
    if (cands.length === 0) return { status: 'EMPTY', optima: [] };
    if (cands.length > MAX_CANDIDATES) {
      throw new PlannerError(
        E_LIMIT,
        `select: ${cands.length} candidates exceeds exact-enumeration limit ${MAX_CANDIDATES}`
      );
    }
    const items = cands.map((c) => ({ id: c.job.id, cost: c.job.cost, score: c.score }));
    const optima = selectOptimal(items, k, budget);
    if (optima.length === 0) return { status: 'OVER_BUDGET', optima: [] };
    return { status: optima.length > 1 ? 'TIE' : 'OK', optima };
  }
}
