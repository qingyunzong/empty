const LEVEL_ORDER = { day: 0, mch: 1, txn: 2 };
export const LEVELS = ['day', 'mch', 'txn'];

export class CyclicParentError extends Error {
  constructor(target) {
    super(`cyclic parent chain detected at target ${target}`);
    this.name = 'CyclicParentError';
    this.code = 'CYCLIC_PARENT';
    this.target = target;
  }
}

export function levelOfTarget(target) {
  const depth = String(target).split('/').length;
  return LEVELS[depth - 1] ?? null;
}

export function parseJsonl(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed) rows.push(JSON.parse(trimmed));
  }
  return rows;
}

export function parseRollbackSpec(spec) {
  const match = /^([a-z]+):([^@]+?)(?:@(\d+))?$/.exec(String(spec).trim());
  if (!match || !LEVELS.includes(match[1])) {
    throw new Error(`invalid rollback spec: ${spec} (expected day|mch|txn:target[@version])`);
  }
  return { level: match[1], target: match[2], version: match[3] ? Number(match[3]) : null };
}

function head(chain) {
  return chain.versions[chain.versions.length - 1];
}

function assertAcyclic(chain) {
  const byVersion = new Map(chain.versions.map((v) => [v.version, v]));
  for (const start of chain.versions) {
    const seen = new Set();
    let cur = start;
    while (cur) {
      if (seen.has(cur.version)) throw new CyclicParentError(chain.target);
      seen.add(cur.version);
      if (cur.parent == null) break;
      cur = byVersion.get(cur.parent) ?? null;
    }
  }
}

export function createState(confirmedRows) {
  const state = { targets: new Map(), extras: [] };
  for (const row of confirmedRows) {
    const target = String(row.target);
    const level = row.level ?? levelOfTarget(target);
    if (!level) throw new Error(`cannot infer level for target ${target}`);
    if (!state.targets.has(target)) {
      state.targets.set(target, { target, level, versions: [], nextVersion: 1 });
    }
    const chain = state.targets.get(target);
    chain.versions.push({
      level,
      target,
      version: row.version ?? chain.nextVersion,
      parent: row.parent ?? null,
      amount: row.amount,
      status: row.status ?? 'confirmed',
      locked: row.locked === true,
    });
    chain.nextVersion = Math.max(chain.nextVersion, chain.versions[chain.versions.length - 1].version + 1);
  }
  for (const chain of state.targets.values()) assertAcyclic(chain);
  return state;
}

function pendingRow(delta) {
  return {
    level: delta.scope ?? levelOfTarget(delta.target),
    target: String(delta.target),
    version: null,
    parent: null,
    amount: null,
    status: 'pending',
  };
}

function eventKey(delta) {
  const parsed = Date.parse(delta.eventTime);
  return { time: Number.isNaN(parsed) ? String(delta.eventTime) : parsed, seq: delta.seq ?? 0 };
}

function compareDeltas(a, b) {
  const ka = eventKey(a);
  const kb = eventKey(b);
  if (ka.time < kb.time) return -1;
  if (ka.time > kb.time) return 1;
  if (ka.seq !== kb.seq) return ka.seq - kb.seq;
  return a._idx - b._idx;
}

function sameKey(a, b) {
  const ka = eventKey(a);
  const kb = eventKey(b);
  return ka.time === kb.time && ka.seq === kb.seq;
}

function applyDelta(chain, delta, status) {
  const parent = head(chain);
  chain.versions.push({
    level: chain.level,
    target: chain.target,
    version: chain.nextVersion++,
    parent: parent.version,
    amount: parent.amount + delta.amount,
    status,
    locked: false,
  });
}

export function applyDeltas(state, deltaRows, { watermark = null } = {}) {
  const watermarkTime = watermark == null ? null : Date.parse(watermark);
  const byTarget = new Map();
  deltaRows.forEach((delta, idx) => {
    const rec = { ...delta, _idx: idx };
    if (watermarkTime != null) {
      const t = Date.parse(delta.eventTime);
      if (!Number.isNaN(t) && t > watermarkTime) {
        state.extras.push(pendingRow(rec));
        return;
      }
    }
    const key = String(delta.target);
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(rec);
  });
  for (const target of [...byTarget.keys()].sort()) {
    const chain = state.targets.get(target);
    const list = byTarget.get(target);
    if (!chain || head(chain).locked) {
      for (const delta of list) state.extras.push(pendingRow(delta));
      continue;
    }
    list.sort(compareDeltas);
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j + 1 < list.length && sameKey(list[j + 1], list[i])) j++;
      const status = j > i ? 'TIE' : 'corrected';
      for (let k = i; k <= j; k++) applyDelta(chain, list[k], status);
      i = j + 1;
    }
  }
  return state;
}

export function rollback(state, specs) {
  for (const spec of specs) {
    const chain = state.targets.get(spec.target);
    if (!chain || chain.level !== spec.level) {
      state.extras.push({
        level: spec.level,
        target: spec.target,
        version: null,
        parent: null,
        amount: null,
        status: 'NO_VERSION',
      });
      continue;
    }
    const affected = [...state.targets.values()]
      .filter((c) => c.target === spec.target || c.target.startsWith(spec.target + '/'))
      .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.target.localeCompare(b.target));
    for (const c of affected) {
      const wanted = spec.version ?? 1;
      const base = c.versions.find((v) => v.version === wanted);
      if (!base) {
        state.extras.push({
          level: c.level,
          target: c.target,
          version: null,
          parent: null,
          amount: null,
          status: 'NO_VERSION',
        });
        continue;
      }
      const parent = head(c);
      c.versions.push({
        level: c.level,
        target: c.target,
        version: c.nextVersion++,
        parent: parent.version,
        amount: base.amount,
        status: 'rolled_back',
        locked: false,
      });
    }
  }
  return state;
}

export function collectRows(state) {
  const rows = [];
  for (const chain of state.targets.values()) {
    for (const v of chain.versions) {
      rows.push({
        level: v.level,
        target: v.target,
        version: v.version,
        parent: v.parent,
        amount: v.amount,
        status: v.status,
      });
    }
  }
  rows.push(...state.extras);
  rows.sort(
    (a, b) =>
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
      String(a.target).localeCompare(String(b.target)) ||
      (a.version ?? Number.MAX_SAFE_INTEGER) - (b.version ?? Number.MAX_SAFE_INTEGER),
  );
  return rows;
}

export function run({ confirmedRows, deltaRows, rollbacks = [], watermark = null }) {
  const state = createState(confirmedRows);
  applyDeltas(state, deltaRows, { watermark });
  rollback(state, rollbacks);
  return collectRows(state);
}
