import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function toCents(amount, field = 'amount') {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error(`invalid ${field}: expected a finite number`);
  }
  return Math.round(amount * 100);
}

function normalizeEntry(entry, kind, index) {
  if (entry === null || typeof entry !== 'object') {
    throw new Error(`${kind}[${index}] must be an object with id and amount`);
  }
  const id = String(entry.id);
  if (id === 'undefined' || id === 'null' || id === '') {
    throw new Error(`${kind}[${index}] has an invalid id`);
  }
  return { id, cents: toCents(entry.amount, `${kind}[${index}].amount`) };
}

function sortById(entries) {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// All non-empty ledger subsets with their sums, in bitmask order.
export function enumerateSubsets(ledgers) {
  const subsets = [];
  const count = ledgers.length;
  for (let mask = 1; mask < 1 << count; mask += 1) {
    const ids = [];
    let sum = 0;
    for (let i = 0; i < count; i += 1) {
      if (mask & (1 << i)) {
        ids.push(ledgers[i].id);
        sum += ledgers[i].cents;
      }
    }
    subsets.push({ ids, sum });
  }
  return subsets;
}

// Combo enumeration order (defines candidate numbering): branch "exact"
// first, then branch "fee"; within each branch ordered by bank id ascending,
// then ledger subset bitmask ascending.
export function enumerateCombos(banks, ledgers, toleranceCents) {
  const subsets = enumerateSubsets(ledgers);
  const combos = [];
  for (const bank of banks) {
    for (const subset of subsets) {
      if (subset.sum === bank.cents) {
        combos.push({ branch: 'exact', bankId: bank.id, ledgerIds: subset.ids, fee: 0 });
      }
    }
  }
  for (const bank of banks) {
    for (const subset of subsets) {
      const diff = bank.cents - subset.sum;
      if (diff !== 0 && Math.abs(diff) <= toleranceCents) {
        combos.push({ branch: 'fee', bankId: bank.id, ledgerIds: subset.ids, fee: diff });
      }
    }
  }
  return combos;
}

export function generateCandidates(bankEntries, ledgerEntries, toleranceCents, startId = 1) {
  const banks = sortById(bankEntries.map((e, i) => normalizeEntry(e, 'bank', i)));
  const ledgers = sortById(ledgerEntries.map((e, i) => normalizeEntry(e, 'ledger', i)));
  return enumerateCombos(banks, ledgers, toleranceCents).map((combo, i) => ({
    id: startId + i,
    ...combo,
  }));
}

function comboKey(combo) {
  return `${combo.branch}|${combo.bankId}|${combo.ledgerIds.join(',')}`;
}

export function createState() {
  return {
    bankPool: [],
    ledgerPool: [],
    tolerance: 0,
    candidates: [],
    nextCandidateId: 1,
  };
}

function findCandidate(state, candidateId) {
  const id = Number(candidateId);
  if (!Number.isInteger(id)) throw new Error(`invalid candidate id: ${candidateId}`);
  const candidate = state.candidates.find((c) => c.id === id);
  if (!candidate) throw new Error(`unknown candidate id: ${id}`);
  return candidate;
}

function addEntries(pool, entries, kind) {
  if (!Array.isArray(entries)) throw new Error(`${kind} entries must be an array`);
  const known = new Set(pool.map((e) => e.id));
  for (const [index, raw] of entries.entries()) {
    const entry = normalizeEntry(raw, kind, index);
    if (known.has(entry.id)) throw new Error(`duplicate ${kind} entry id: ${entry.id}`);
    known.add(entry.id);
    pool.push(entry);
  }
  pool.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function applyEvent(state, event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be an object');
  }
  switch (event.type) {
    case 'suggest': {
      const tolerance =
        event.tolerance === undefined ? state.tolerance : toCents(event.tolerance, 'tolerance');
      if (tolerance < 0) throw new Error('tolerance must be >= 0');
      addEntries(state.bankPool, event.bank ?? [], 'bank');
      addEntries(state.ledgerPool, event.ledger ?? [], 'ledger');
      state.tolerance = tolerance;

      const existing = new Set(state.candidates.map(comboKey));
      const usedBank = new Set();
      const usedLedger = new Set();
      for (const c of state.candidates) {
        if (c.status !== 'rejected') {
          usedBank.add(c.bankId);
          for (const id of c.ledgerIds) usedLedger.add(id);
        }
      }
      const combos = enumerateCombos(state.bankPool, state.ledgerPool, tolerance);
      for (const combo of combos) {
        if (existing.has(comboKey(combo))) continue;
        const candidate = { id: state.nextCandidateId, ...combo };
        state.nextCandidateId += 1;
        const conflict =
          usedBank.has(candidate.bankId) || candidate.ledgerIds.some((id) => usedLedger.has(id));
        if (conflict) {
          candidate.status = 'rejected';
        } else {
          candidate.status = 'suggested';
          usedBank.add(candidate.bankId);
          for (const id of candidate.ledgerIds) usedLedger.add(id);
        }
        state.candidates.push(candidate);
      }
      return state;
    }
    case 'confirm': {
      const candidate = findCandidate(state, event.candidateId);
      if (candidate.status === 'rejected') {
        throw new Error(`candidate ${candidate.id} was rejected and cannot be confirmed`);
      }
      if (candidate.status === 'confirmed') {
        throw new Error(`candidate ${candidate.id} is already confirmed`);
      }
      candidate.status = 'confirmed';
      return state;
    }
    case 'undo': {
      const candidate = findCandidate(state, event.candidateId);
      if (candidate.status !== 'confirmed') {
        throw new Error(`candidate ${candidate.id} is not confirmed`);
      }
      candidate.status = 'suggested';
      return state;
    }
    default:
      throw new Error(`unknown event type: ${String(event.type)}`);
  }
}

export function certificate(state) {
  const matches = state.candidates
    .filter((c) => c.status === 'confirmed')
    .map((c) => ({
      candidateId: c.id,
      bankId: c.bankId,
      ledgerIds: [...c.ledgerIds].sort(),
      feeCents: c.fee,
    }));
  const corrections = matches
    .filter((m) => m.feeCents !== 0)
    .map((m) => ({ candidateId: m.candidateId, amountCents: m.feeCents }));
  return { matches, corrections };
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function stateHash(state) {
  const snapshot = {
    bankPool: state.bankPool,
    ledgerPool: state.ledgerPool,
    tolerance: state.tolerance,
    candidates: state.candidates.map((c) => ({
      id: c.id,
      branch: c.branch,
      bankId: c.bankId,
      ledgerIds: c.ledgerIds,
      fee: c.fee,
      status: c.status,
    })),
    certificate: certificate(state),
  };
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

export function replay(events) {
  const state = createState();
  for (const event of events) applyEvent(state, event);
  return state;
}

export const LOG_FILE = 'events.jsonl';

export function loadEvents(workdir) {
  const path = join(workdir, LOG_FILE);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export function appendEvents(workdir, events) {
  mkdirSync(workdir, { recursive: true });
  if (events.length === 0) return;
  appendFileSync(join(workdir, LOG_FILE), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
