'use strict';

const crypto = require('node:crypto');

const EPS = 1e-9;

class ReconError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'ReconError';
    this.exitCode = exitCode;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function round6(x) {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

function normalizeRecord(obj, source, lineNo) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new ReconError(`${source}:${lineNo}: record must be a JSON object`, 1);
  }
  const rec = { ...obj };
  rec.source = source;
  rec.seq = lineNo - 1;
  if (rec.explicitId !== undefined && rec.explicitId !== null) {
    rec.explicitId = String(rec.explicitId);
  } else {
    rec.explicitId = null;
  }
  if (typeof rec.amount !== 'number' || !Number.isFinite(rec.amount)) {
    throw new ReconError(`${source}:${lineNo}: amount must be a finite number`, 1);
  }
  return rec;
}

function parseJsonl(text, source) {
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      throw new ReconError(`${source}:${i + 1}: invalid JSON: ${err.message}`, 1);
    }
    records.push(normalizeRecord(obj, source, i + 1));
  }
  const byId = new Map();
  for (const rec of records) {
    if (rec.explicitId === null) continue;
    if (byId.has(rec.explicitId)) {
      throw new ReconError(
        `${source}: duplicate explicitId ${JSON.stringify(rec.explicitId)} (lines ${byId.get(rec.explicitId) + 1} and ${rec.seq + 1})`,
        18,
      );
    }
    byId.set(rec.explicitId, rec.seq);
  }
  return records;
}

function groupKeyOf(rec) {
  if (rec.explicitId !== null) return `id:${rec.explicitId}`;
  return `key:${rec.valueDate}|${rec.account}|${rec.ccy}`;
}

function fullKeyOf(rec) {
  return `${rec.valueDate}|${rec.account}|${rec.ccy}|${rec.amount}`;
}

function compareRecs(a, b) {
  if (a.amount !== b.amount) return a.amount - b.amount;
  const ad = a.valueDate == null ? '' : String(a.valueDate);
  const bd = b.valueDate == null ? '' : String(b.valueDate);
  if (ad !== bd) return ad < bd ? -1 : 1;
  const ai = a.explicitId == null ? '' : a.explicitId;
  const bi = b.explicitId == null ? '' : b.explicitId;
  if (ai !== bi) return ai < bi ? -1 : 1;
  return a.seq - b.seq;
}

// Maximum bipartite matching (Kuhn) between bank and core records of one
// group. An edge exists when |bank.amount - core.amount| <= tol. Candidate
// order is deterministic: smallest amount diff first, ties broken by
// (valueDate, explicitId, seq) lexicographic order.
function matchAmounts(bankRecs, coreRecs, tol) {
  const bank = [...bankRecs].sort(compareRecs);
  const core = [...coreRecs].sort(compareRecs);
  const adjacency = bank.map((b) =>
    core
      .map((c, j) => ({ j, diff: Math.abs(b.amount - c.amount) }))
      .filter((x) => x.diff <= tol + EPS)
      .sort((x, y) => x.diff - y.diff || compareRecs(core[x.j], core[y.j]))
      .map((x) => x.j),
  );
  const matchCore = new Array(core.length).fill(-1);
  function tryMatch(v, seen) {
    for (const j of adjacency[v]) {
      if (seen[j]) continue;
      seen[j] = true;
      if (matchCore[j] === -1 || tryMatch(matchCore[j], seen)) {
        matchCore[j] = v;
        return true;
      }
    }
    return false;
  }
  for (let v = 0; v < bank.length; v += 1) {
    tryMatch(v, new Array(core.length).fill(false));
  }
  const pairs = [];
  const matchedBank = new Set();
  const matchedCore = new Set();
  for (let j = 0; j < core.length; j += 1) {
    if (matchCore[j] !== -1) {
      pairs.push({ bank: bank[matchCore[j]], core: core[j] });
      matchedBank.add(matchCore[j]);
      matchedCore.add(j);
    }
  }
  pairs.sort((x, y) => compareRecs(x.bank, y.bank));
  return {
    pairs,
    unmatchedBank: bank.filter((_, i) => !matchedBank.has(i)),
    unmatchedCore: core.filter((_, j) => !matchedCore.has(j)),
  };
}

function canonRecord(rec) {
  if (!rec) return null;
  return {
    source: rec.source,
    explicitId: rec.explicitId,
    valueDate: rec.valueDate ?? null,
    account: rec.account ?? null,
    ccy: rec.ccy ?? null,
    amount: rec.amount,
  };
}

function trioHash(bank, core, adj) {
  return canonicalHash({ adj: canonRecord(adj), bank: canonRecord(bank), core: canonRecord(core) });
}

function withinTol(a, b, tol) {
  return Math.abs(a - b) <= tol + EPS;
}

function buildIndexes(records) {
  const byId = new Map();
  const byKey = new Map();
  for (const rec of records) {
    if (rec.explicitId !== null && !byId.has(rec.explicitId)) byId.set(rec.explicitId, rec);
    const fk = fullKeyOf(rec);
    if (!byKey.has(fk)) byKey.set(fk, rec);
  }
  return { byId, byKey };
}

function resolveRef(ref, indexes, source, side) {
  if (ref === undefined || ref === null) return null;
  let rec = null;
  if (typeof ref === 'string' || typeof ref === 'number') {
    rec = indexes.byId.get(String(ref)) ?? null;
  } else if (typeof ref === 'object') {
    if (ref.explicitId !== undefined && ref.explicitId !== null) {
      rec = indexes.byId.get(String(ref.explicitId)) ?? null;
    } else {
      rec = indexes.byKey.get(`${ref.valueDate}|${ref.account}|${ref.ccy}|${ref.amount}`) ?? null;
    }
  }
  if (!rec) {
    throw new ReconError(
      `adj: dangling link (${side} -> ${stableStringify(ref)})`,
      20,
    );
  }
  return rec;
}

function reconcile({ bank, core, adj, tol }) {
  const groups = new Map();
  const groupOf = (key) => {
    if (!groups.has(key)) groups.set(key, { bank: [], core: [] });
    return groups.get(key);
  };
  for (const rec of bank) groupOf(groupKeyOf(rec)).bank.push(rec);
  for (const rec of core) groupOf(groupKeyOf(rec)).core.push(rec);

  const pairs = [];
  const conflicts = [];
  const pairByBankRec = new Map();
  const pairByCoreRec = new Map();
  const pairsByGroup = new Map();

  for (const [key, group] of [...groups.entries()].sort()) {
    // explicitId groups pair strictly by id (ids are unique per file); key
    // groups pair by amount multiset within tolerance.
    let matched;
    let unmatchedBank;
    let unmatchedCore;
    if (key.startsWith('id:')) {
      matched = group.bank.length === 1 && group.core.length === 1 ? [{ bank: group.bank[0], core: group.core[0] }] : [];
      unmatchedBank = matched.length ? [] : group.bank;
      unmatchedCore = matched.length ? [] : group.core;
    } else {
      const result = matchAmounts(group.bank, group.core, tol);
      matched = result.pairs;
      unmatchedBank = result.unmatchedBank;
      unmatchedCore = result.unmatchedCore;
    }
    for (const pair of matched) {
      const entry = { key, bank: pair.bank, core: pair.core, adj: [] };
      pairs.push(entry);
      pairByBankRec.set(pair.bank, entry);
      pairByCoreRec.set(pair.core, entry);
      if (!pairsByGroup.has(key)) pairsByGroup.set(key, []);
      pairsByGroup.get(key).push(entry);
    }
    for (const rec of unmatchedBank) {
      conflicts.push({
        rule: 'MISSING_CORE',
        hash: trioHash(rec, null, null),
        bank: canonRecord(rec),
        core: null,
        adj: null,
      });
    }
    for (const rec of unmatchedCore) {
      conflicts.push({
        rule: 'UNSETTLED',
        hash: trioHash(null, rec, null),
        bank: null,
        core: canonRecord(rec),
        adj: null,
      });
    }
  }

  const bankIdx = buildIndexes(bank);
  const coreIdx = buildIndexes(core);

  for (const adjRec of adj) {
    let target = null;
    if (adjRec.link !== undefined && adjRec.link !== null) {
      const link = adjRec.link;
      const linkedBank = resolveRef(link.bank, bankIdx, 'adj', 'bank');
      const linkedCore = resolveRef(link.core, coreIdx, 'adj', 'core');
      if (linkedBank && pairByBankRec.has(linkedBank)) target = pairByBankRec.get(linkedBank);
      else if (linkedCore && pairByCoreRec.has(linkedCore)) target = pairByCoreRec.get(linkedCore);
      // Linked records that are not part of a matched pair: the adj is
      // evaluated against whichever side exists.
      if (!target && (linkedBank || linkedCore)) {
        const b = linkedBank;
        const c = linkedCore;
        const amounts = [b?.amount, c?.amount, adjRec.amount].filter((x) => x !== undefined);
        const sideConflict =
          (b && !withinTol(b.amount, adjRec.amount, tol)) ||
          (c && !withinTol(c.amount, adjRec.amount, tol));
        if (sideConflict) {
          conflicts.push({
            rule: 'ADJ_CONFLICT',
            hash: trioHash(b ?? null, c ?? null, adjRec),
            bank: canonRecord(b ?? null),
            core: canonRecord(c ?? null),
            adj: canonRecord(adjRec),
          });
        }
        continue;
      }
    } else {
      const groupPairs = pairsByGroup.get(groupKeyOf(adjRec));
      if (groupPairs && groupPairs.length > 0) {
        target = groupPairs
          .map((p) => ({ p, diff: Math.abs(p.bank.amount - adjRec.amount) }))
          .sort((x, y) => x.diff - y.diff || compareRecs(x.p.bank, y.p.bank))[0].p;
      }
    }
    if (target) target.adj.push(adjRec);
  }

  const entries = [];
  for (const pair of pairs) {
    let broken = null;
    for (const adjRec of pair.adj) {
      const bankOk = withinTol(pair.bank.amount, adjRec.amount, tol);
      const coreOk = withinTol(pair.core.amount, adjRec.amount, tol);
      if (bankOk && coreOk) continue;
      const pairwiseDifferent =
        !withinTol(pair.bank.amount, pair.core.amount, tol) &&
        !withinTol(pair.bank.amount, adjRec.amount, tol) &&
        !withinTol(pair.core.amount, adjRec.amount, tol);
      const rule = pair.bank.explicitId !== null && pairwiseDifferent ? 'THREE_WAY' : 'ADJ_CONFLICT';
      broken = { rule, adjRec };
      break;
    }
    if (broken) {
      conflicts.push({
        rule: broken.rule,
        hash: trioHash(pair.bank, pair.core, broken.adjRec),
        bank: canonRecord(pair.bank),
        core: canonRecord(pair.core),
        adj: canonRecord(broken.adjRec),
      });
      continue;
    }
    const adjRec = pair.adj[0] ?? null;
    entries.push({
      key: pair.key,
      explicitId: pair.bank.explicitId ?? pair.core.explicitId,
      valueDate: pair.bank.valueDate ?? pair.core.valueDate ?? null,
      account: pair.bank.account ?? pair.core.account ?? null,
      ccy: pair.bank.ccy ?? pair.core.ccy ?? null,
      amount: pair.bank.amount,
      coreAmount: pair.core.amount,
      rounding: round6(pair.core.amount - pair.bank.amount),
      adjAmount: adjRec ? adjRec.amount : null,
      hash: trioHash(pair.bank, pair.core, adjRec),
    });
  }

  entries.sort((a, b) => {
    const ka = [a.valueDate ?? '', a.account ?? '', a.ccy ?? ''];
    const kb = [b.valueDate ?? '', b.account ?? '', b.ccy ?? ''];
    for (let i = 0; i < 3; i += 1) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    if (a.amount !== b.amount) return a.amount - b.amount;
    const ia = a.explicitId ?? '';
    const ib = b.explicitId ?? '';
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
  });
  conflicts.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  return { entries, conflicts };
}

module.exports = {
  EPS,
  ReconError,
  stableStringify,
  canonicalHash,
  round6,
  parseJsonl,
  groupKeyOf,
  compareRecs,
  matchAmounts,
  reconcile,
};
