export const E_LIMIT = 'E_LIMIT';
export const E_TIE = 'E_TIE';
export const E_STATE = 'E_STATE';

export class PlannerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
  }
}

export const PHRASE_TOKENS = ['低温', '固化'];
export const MAX_GAP = 6;
export const MAX_K = 10;
export const MAX_ENUM = 20;
export const MAX_TOKENS = 500;

export function tokenize(text) {
  return String(text).split(/\s+/u).filter((token) => token.length > 0);
}

// Independent linear-scan verifier: re-reads the raw description and never
// touches the inverted index. Used to exactly confirm index-produced candidates.
export function linearScan(description, material, equipment) {
  const tokens = tokenize(description);
  const phrasePositions = [];
  for (let i = 0; i + PHRASE_TOKENS.length <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < PHRASE_TOKENS.length; j += 1) {
      if (tokens[i + j] !== PHRASE_TOKENS[j]) {
        ok = false;
        break;
      }
    }
    if (ok) phrasePositions.push(i);
  }
  const materialPositions = [];
  const equipmentPositions = [];
  tokens.forEach((token, pos) => {
    if (token === material) materialPositions.push(pos);
    if (token === equipment) equipmentPositions.push(pos);
  });
  let minGap = null;
  for (const m of materialPositions) {
    for (const e of equipmentPositions) {
      const gap = Math.max(0, Math.abs(m - e) - 1);
      if (minGap === null || gap < minGap) minGap = gap;
    }
  }
  const phraseOk = phrasePositions.length > 0;
  const proximityOk = minGap !== null && minGap <= MAX_GAP;
  return {
    match: phraseOk && proximityOk,
    phraseOk,
    proximityOk,
    minGap,
    phrasePositions,
    materialPositions,
    equipmentPositions,
    hits: phrasePositions.length + materialPositions.length + equipmentPositions.length,
  };
}

function addToSetIndex(index, key, id) {
  let bucket = index.get(key);
  if (!bucket) {
    bucket = new Set();
    index.set(key, bucket);
  }
  bucket.add(id);
}

function compareIdLists(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export class Planner {
  constructor() {
    this.jobs = new Map();
    this.descIndex = new Map();
    this.materialIndex = new Map();
    this.equipmentIndex = new Map();
    this.audit = [];
    this.seq = 0;
  }

  _log(action, id) {
    this.seq += 1;
    this.audit.push({ seq: this.seq, action, id });
  }

  _insert(job) {
    this.jobs.set(job.id, job);
    tokenize(job.description).forEach((token, pos) => {
      let postings = this.descIndex.get(token);
      if (!postings) {
        postings = new Map();
        this.descIndex.set(token, postings);
      }
      let positions = postings.get(job.id);
      if (!positions) {
        positions = [];
        postings.set(job.id, positions);
      }
      positions.push(pos);
    });
    addToSetIndex(this.materialIndex, job.material, job.id);
    addToSetIndex(this.equipmentIndex, job.equipment, job.id);
  }

  addJob({ id, description, material, equipment, cost, overdue }) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new PlannerError(E_LIMIT, 'id must be a non-empty string');
    }
    if (this.jobs.has(id)) {
      throw new PlannerError(E_STATE, `job ${id} already exists`);
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      throw new PlannerError(E_LIMIT, 'description must be a non-empty string');
    }
    if (typeof material !== 'string' || material.length === 0) {
      throw new PlannerError(E_LIMIT, 'material must be a non-empty string');
    }
    if (typeof equipment !== 'string' || equipment.length === 0) {
      throw new PlannerError(E_LIMIT, 'equipment must be a non-empty string');
    }
    if (!Number.isInteger(cost) || cost < 0) {
      throw new PlannerError(E_LIMIT, 'cost must be a non-negative integer');
    }
    if (!Number.isInteger(overdue) || overdue < 0) {
      throw new PlannerError(E_LIMIT, 'overdue must be a non-negative integer');
    }
    if (tokenize(description).length > MAX_TOKENS) {
      throw new PlannerError(E_LIMIT, `description exceeds ${MAX_TOKENS} tokens`);
    }
    const job = { id, description, material, equipment, cost, overdue, voided: false };
    this._insert(job);
    this._log('add', id);
    return { ...job };
  }

  voidJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw new PlannerError(E_STATE, `unknown job ${id}`);
    if (job.voided) throw new PlannerError(E_STATE, `job ${id} is already voided`);
    job.voided = true;
    this._log('void', id);
  }

  restoreJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw new PlannerError(E_STATE, `unknown job ${id}`);
    if (!job.voided) throw new PlannerError(E_STATE, `job ${id} is not voided`);
    job.voided = false;
    this._log('restore', id);
  }

  // Candidate generation from the inverted index only (voided jobs included;
  // callers filter). Necessary-but-not-sufficient: linearScan confirms exactly.
  indexCandidates(material, equipment) {
    const byMaterial = this.materialIndex.get(material);
    if (!byMaterial) return [];
    const byEquipment = this.equipmentIndex.get(equipment);
    if (!byEquipment) return [];
    const postings = PHRASE_TOKENS.map((token) => this.descIndex.get(token));
    if (postings.some((entry) => !entry)) return [];
    const ids = [];
    for (const id of byMaterial) {
      if (!byEquipment.has(id)) continue;
      if (postings.every((entry) => entry.has(id))) ids.push(id);
    }
    return ids.sort();
  }

  select({ material, equipment, k, budget, one = false }) {
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
      throw new PlannerError(E_LIMIT, `k must be an integer in [1, ${MAX_K}]`);
    }
    if (!Number.isInteger(budget) || budget < 0) {
      throw new PlannerError(E_LIMIT, 'budget must be a non-negative integer');
    }
    const candidateIds = this.indexCandidates(material, equipment)
      .filter((id) => !this.jobs.get(id).voided);
    const eligible = [];
    for (const id of candidateIds) {
      const job = this.jobs.get(id);
      const scan = linearScan(job.description, material, equipment);
      if (!scan.match) continue;
      eligible.push({ id, cost: job.cost, score: scan.hits * 10 - job.overdue });
    }
    if (eligible.length === 0) {
      return { status: 'EMPTY', k, budget, best: null, results: [] };
    }
    if (eligible.length > MAX_ENUM) {
      throw new PlannerError(
        E_LIMIT,
        `${eligible.length} eligible jobs exceed enumeration limit ${MAX_ENUM}`,
      );
    }
    const n = eligible.length;
    const maxSize = Math.min(k, n);
    let best = null;
    let ties = [];
    const total = 1 << n;
    for (let mask = 1; mask < total; mask += 1) {
      let bits = 0;
      for (let m = mask; m !== 0; m >>= 1) bits += m & 1;
      if (bits > maxSize) continue;
      let cost = 0;
      let score = 0;
      const ids = [];
      for (let i = 0; i < n; i += 1) {
        if (mask & (1 << i)) {
          cost += eligible[i].cost;
          score += eligible[i].score;
          ids.push(eligible[i].id);
        }
      }
      if (cost > budget) continue;
      const remaining = budget - cost;
      ids.sort();
      if (!best || score > best.score || (score === best.score && remaining > best.remaining)) {
        best = { score, cost, remaining };
        ties = [ids];
      } else if (score === best.score && remaining === best.remaining) {
        ties.push(ids);
      }
    }
    if (!best) {
      return {
        status: 'OVER_BUDGET',
        k,
        budget,
        best: null,
        results: [],
        eligible: eligible.map((entry) => entry.id),
      };
    }
    ties.sort(compareIdLists);
    if (one && ties.length > 1) {
      throw new PlannerError(
        E_TIE,
        `${ties.length} tied optima: ${ties.map((ids) => ids.join(',')).join(' | ')}`,
      );
    }
    return {
      status: 'OK',
      k,
      budget,
      best,
      results: ties.map((ids) => ({ jobs: ids, score: best.score, cost: best.cost, remaining: best.remaining })),
    };
  }

  explain(id, { material, equipment }) {
    const job = this.jobs.get(id);
    if (!job) throw new PlannerError(E_STATE, `unknown job ${id}`);
    const indexIds = this.indexCandidates(material, equipment);
    const inIndex = indexIds.includes(id);
    const scan = linearScan(job.description, material, equipment);
    let decision;
    if (!inIndex) decision = 'rejected-by-index';
    else if (job.voided) decision = 'excluded-voided';
    else if (!scan.match) decision = 'rejected-by-scan';
    else decision = 'eligible';
    return {
      id,
      voided: job.voided,
      decision,
      sources: {
        invertedIndex: { matched: inIndex, candidateIds: indexIds },
        linearScan: scan,
      },
      hits: scan.hits,
      score: scan.hits * 10 - job.overdue,
      audit: this.audit.filter((entry) => entry.id === id),
    };
  }

  toJSON() {
    return {
      jobs: [...this.jobs.values()],
      audit: this.audit,
      seq: this.seq,
    };
  }

  static fromJSON(data) {
    const planner = new Planner();
    for (const job of data.jobs ?? []) {
      planner._insert({ ...job });
    }
    planner.audit = Array.isArray(data.audit) ? data.audit : [];
    planner.seq = Number.isInteger(data.seq) ? data.seq : planner.audit.length;
    return planner;
  }
}
