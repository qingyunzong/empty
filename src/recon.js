import { createHash } from 'node:crypto';

export class ReconError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'ReconError';
    this.exitCode = exitCode;
  }
}

const EPS = 1e-9;

const round6 = (x) => Math.round(x * 1e6) / 1e6 + 0;

const within = (a, b, tol) => Math.abs(a - b) <= tol + EPS;

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Canonical order for greedy matching: amount first (needed for the
// amount-window greedy), then date/id for determinism.
const byAmountDateId = (x, y) =>
  x.amount - y.amount ||
  cmpStr(x.valueDate ?? '', y.valueDate ?? '') ||
  cmpStr(x.id, y.id);

// Canonical order for the brute-force enumerator: tie-breaks are specified
// as date/id lexicographic, amount last.
const byDateIdAmount = (x, y) =>
  cmpStr(x.valueDate ?? '', y.valueDate ?? '') ||
  cmpStr(x.id, y.id) ||
  x.amount - y.amount;

/**
 * Greedy maximum matching of bank/core amounts within tolerance.
 * Both sides sorted by amount; each bank takes the smallest available core
 * inside [b - tol, b + tol]. Optimal for points on a line.
 */
export function greedyMatch(bankRecs, coreRecs, tol) {
  const bank = [...bankRecs].sort(byAmountDateId);
  const core = [...coreRecs].sort(byAmountDateId);
  const used = new Array(core.length).fill(false);
  const pairs = [];
  for (const b of bank) {
    for (let k = 0; k < core.length; k++) {
      if (used[k]) continue;
      if (core[k].amount < b.amount - tol - EPS) continue;
      if (core[k].amount > b.amount + tol + EPS) break;
      used[k] = true;
      pairs.push({ bank: b, core: core[k] });
      break;
    }
  }
  const pairedBank = new Set(pairs.map((p) => p.bank));
  const pairedCore = new Set(pairs.map((p) => p.core));
  return {
    pairs,
    unmatchedBank: bank.filter((r) => !pairedBank.has(r)),
    unmatchedCore: core.filter((r) => !pairedCore.has(r)),
  };
}

/**
 * Independent Cartesian enumeration of all matchings (used to verify the
 * greedy matcher for n <= 7). Selects the matching with maximum cardinality;
 * ties are broken by date/id lexicographic order of the paired records,
 * which makes the result deterministic.
 */
export function bruteForceMatch(bankRecs, coreRecs, tol) {
  const bank = [...bankRecs].sort(byDateIdAmount);
  const core = [...coreRecs].sort(byDateIdAmount);
  const n = bank.length;
  const m = core.length;
  const compat = bank.map((b) => core.map((c) => within(b.amount, c.amount, tol)));
  const choices = new Array(n).fill(-1);
  const used = new Array(m).fill(false);
  let best = null;
  const isBetter = (count, cand) => {
    if (!best || count !== best.count) return !best || count > best.count;
    for (let i = 0; i < n; i++) {
      const a = cand[i] === -1 ? Infinity : cand[i];
      const b = best.choices[i] === -1 ? Infinity : best.choices[i];
      if (a !== b) return a < b;
    }
    return false;
  };
  const dfs = (i, count) => {
    if (i === n) {
      if (isBetter(count, choices)) best = { count, choices: [...choices] };
      return;
    }
    choices[i] = -1;
    dfs(i + 1, count);
    for (let j = 0; j < m; j++) {
      if (used[j] || !compat[i][j]) continue;
      used[j] = true;
      choices[i] = j;
      dfs(i + 1, count + 1);
      used[j] = false;
    }
  };
  dfs(0, 0);
  const pairs = [];
  const pairedBank = new Set();
  const pairedCore = new Set();
  best.choices.forEach((ci, bi) => {
    if (ci === -1) return;
    pairs.push({ bank: bank[bi], core: core[ci] });
    pairedBank.add(bank[bi]);
    pairedCore.add(core[ci]);
  });
  return {
    pairs,
    unmatchedBank: bank.filter((r) => !pairedBank.has(r)),
    unmatchedCore: core.filter((r) => !pairedCore.has(r)),
  };
}

/**
 * Multiset amount matching for one key group. For n <= 7 the result is
 * verified against the independent Cartesian enumeration (maximum and
 * deterministic); the enumeration result is authoritative.
 */
export function matchAmounts(bankRecs, coreRecs, tol) {
  const greedy = greedyMatch(bankRecs, coreRecs, tol);
  if (Math.max(bankRecs.length, coreRecs.length) <= 7) {
    const brute = bruteForceMatch(bankRecs, coreRecs, tol);
    if (brute.pairs.length !== greedy.pairs.length) {
      throw new ReconError(
        `internal: greedy matched ${greedy.pairs.length} but enumeration matched ${brute.pairs.length}`,
        1,
      );
    }
    return brute;
  }
  return greedy;
}

const TUPLE_FIELDS = ['valueDate', 'account', 'ccy'];

function validateAmount(rec, source, line) {
  if (typeof rec.amount !== 'number' || !Number.isFinite(rec.amount)) {
    throw new ReconError(`${source}:${line}: amount must be a finite number`, 2);
  }
}

/**
 * Parse JSONL text into normalized records. Each record gets a stable `id`
 * (explicitId when present, otherwise `<source>#<line>`). Duplicate
 * explicitId within one file is an error (exit 18).
 */
export function parseJsonl(text, source) {
  const records = [];
  const seenIds = new Set();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const line = i + 1;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new ReconError(`${source}:${line}: invalid JSON`, 2);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new ReconError(`${source}:${line}: record must be a JSON object`, 2);
    }
    validateAmount(obj, source, line);
    const explicitId = obj.explicitId ?? null;
    if (explicitId !== null) {
      if (typeof explicitId !== 'string' || explicitId === '') {
        throw new ReconError(`${source}:${line}: explicitId must be a non-empty string`, 2);
      }
      if (seenIds.has(explicitId)) {
        throw new ReconError(`${source}:${line}: duplicate explicitId ${JSON.stringify(explicitId)}`, 18);
      }
      seenIds.add(explicitId);
    }
    if (source === 'adj') {
      if (obj.link !== undefined && (typeof obj.link !== 'string' || obj.link === '')) {
        throw new ReconError(`${source}:${line}: link must be a non-empty string`, 2);
      }
      if (!obj.link && !explicitId) {
        for (const f of TUPLE_FIELDS) {
          if (typeof obj[f] !== 'string' || obj[f] === '') {
            throw new ReconError(`${source}:${line}: adj without link/explicitId requires ${f}`, 2);
          }
        }
      }
    } else {
      for (const f of TUPLE_FIELDS) {
        if (typeof obj[f] !== 'string' || obj[f] === '') {
          throw new ReconError(`${source}:${line}: missing required field ${f}`, 2);
        }
      }
    }
    records.push({
      id: explicitId ?? `${source}#${line}`,
      explicitId,
      valueDate: obj.valueDate ?? null,
      account: obj.account ?? null,
      ccy: obj.ccy ?? null,
      amount: obj.amount,
      link: obj.link ?? null,
      line,
      source,
    });
  }
  return records;
}

const groupKeyFor = (rec) =>
  rec.explicitId ? `id:${rec.explicitId}` : `key:${rec.valueDate}|${rec.account}|${rec.ccy}`;

function adjGroupKey(rec, bank, core, tol) {
  if (rec.link) {
    if (rec.link.includes('|')) {
      const [valueDate, account, ccy, amountStr] = rec.link.split('|');
      const linkAmount = Number(amountStr);
      const hit = [...bank, ...core].some(
        (x) =>
          x.valueDate === valueDate &&
          x.account === account &&
          x.ccy === ccy &&
          (!Number.isFinite(linkAmount) || within(x.amount, linkAmount, tol)),
      );
      if (!hit) throw new ReconError(`adj link dangling: ${JSON.stringify(rec.link)}`, 20);
      return `key:${valueDate}|${account}|${ccy}`;
    }
    const hit = [...bank, ...core].some((x) => x.explicitId === rec.link);
    if (!hit) throw new ReconError(`adj link dangling: ${JSON.stringify(rec.link)}`, 20);
    return `id:${rec.link}`;
  }
  return groupKeyFor(rec);
}

function groupHash(group) {
  const canon = {
    key: group.key,
    bank: group.bank.map((r) => round6(r.amount)).sort((a, b) => a - b),
    core: group.core.map((r) => round6(r.amount)).sort((a, b) => a - b),
    adj: group.adj.map((r) => round6(r.amount)).sort((a, b) => a - b),
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

function mkConflict(rule, group, bankRecs, coreRecs, adjRecs, detail) {
  return {
    rule,
    key: group.key,
    hash: groupHash(group),
    bank: bankRecs.map((r) => r.id),
    core: coreRecs.map((r) => r.id),
    adj: adjRecs.map((r) => r.id),
    amounts: {
      bank: bankRecs.map((r) => r.amount),
      core: coreRecs.map((r) => r.amount),
      adj: adjRecs.map((r) => r.amount),
    },
    detail,
  };
}

function mkEntry(group, pair, adjRec) {
  const b = pair.bank;
  const c = pair.core;
  return {
    key: group.key,
    explicitId: b.explicitId ?? null,
    valueDate: b.valueDate,
    account: b.account,
    ccy: b.ccy,
    amount: b.amount,
    rounding: {
      core: round6(c.amount - b.amount),
      adj: adjRec ? round6(adjRec.amount - b.amount) : null,
    },
    bankId: b.id,
    coreId: c.id,
    adjId: adjRec ? adjRec.id : null,
  };
}

function reconcileGroup(group, tol, entries, conflicts) {
  const { bank, core, adj } = group;
  // THREE_WAY: same explicitId, one record per side, amounts pairwise different.
  if (
    group.key.startsWith('id:') &&
    bank.length === 1 &&
    core.length === 1 &&
    adj.length === 1 &&
    !within(bank[0].amount, core[0].amount, tol) &&
    !within(bank[0].amount, adj[0].amount, tol) &&
    !within(core[0].amount, adj[0].amount, tol)
  ) {
    conflicts.push(
      mkConflict('THREE_WAY', group, bank, core, adj, 'amounts differ pairwise across bank/core/adj'),
    );
    return;
  }
  const matched = matchAmounts(bank, core, tol);
  // Assign adjustments to pairs: an adj agrees with a pair only when it is
  // within tolerance of BOTH sides (three-way agreement).
  const adjSorted = [...adj].sort(byAmountDateId);
  const usedAdj = new Set();
  const pairAdj = matched.pairs.map((pair) => {
    for (const a of adjSorted) {
      if (usedAdj.has(a)) continue;
      if (within(a.amount, pair.bank.amount, tol) && within(a.amount, pair.core.amount, tol)) {
        usedAdj.add(a);
        return a;
      }
    }
    return null;
  });
  for (const a of adjSorted) {
    if (!usedAdj.has(a)) {
      conflicts.push(
        mkConflict('ADJ_CONFLICT', group, [], [], [a], `adj amount ${a.amount} conflicts with bank/core`),
      );
    }
  }
  matched.pairs.forEach((pair, i) => {
    // When adjustments are attached to the key, only fully three-way
    // consistent pairs are booked.
    if (adj.length === 0 || pairAdj[i]) entries.push(mkEntry(group, pair, pairAdj[i]));
  });
  for (const b of matched.unmatchedBank) {
    conflicts.push(mkConflict('MISSING_CORE', group, [b], [], [], 'bank record has no matching core record'));
  }
  for (const c of matched.unmatchedCore) {
    conflicts.push(mkConflict('UNSETTLED', group, [], [c], [], 'core record has no matching bank record'));
  }
}

const withIds = (records, source) =>
  records.map((r, i) => (r.id ? r : { ...r, id: `${source}#${i + 1}` }));

/**
 * Reconcile bank/core/adj records.
 * Returns { entries, conflicts }; deterministic for identical inputs.
 */
export function reconcile({ bank, core, adj, tol = 0 }) {
  if (!(typeof tol === 'number' && Number.isFinite(tol) && tol >= 0)) {
    throw new ReconError(`tolerance must be a non-negative number, got ${tol}`, 19);
  }
  const bankRecs = withIds(bank, 'bank');
  const coreRecs = withIds(core, 'core');
  const adjRecs = withIds(adj, 'adj');
  const groups = new Map();
  const getGroup = (key) => {
    if (!groups.has(key)) groups.set(key, { key, bank: [], core: [], adj: [] });
    return groups.get(key);
  };
  for (const r of bankRecs) getGroup(groupKeyFor(r)).bank.push(r);
  for (const r of coreRecs) getGroup(groupKeyFor(r)).core.push(r);
  for (const r of adjRecs) getGroup(adjGroupKey(r, bankRecs, coreRecs, tol)).adj.push(r);
  const entries = [];
  const conflicts = [];
  for (const group of [...groups.values()].sort((a, b) => cmpStr(a.key, b.key))) {
    reconcileGroup(group, tol, entries, conflicts);
  }
  entries.sort(
    (x, y) => cmpStr(x.key, y.key) || cmpStr(x.bankId, y.bankId) || cmpStr(x.coreId, y.coreId),
  );
  conflicts.sort(
    (x, y) =>
      cmpStr(x.key, y.key) ||
      cmpStr(x.rule, y.rule) ||
      cmpStr(JSON.stringify(x.amounts), JSON.stringify(y.amounts)),
  );
  return { entries, conflicts };
}
