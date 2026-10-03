'use strict';

const crypto = require('node:crypto');

class ReconError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function hashCertificate(certificate) {
  return crypto.createHash('sha256').update(canonicalize(certificate)).digest('hex');
}

function* combinationIndices(n, k) {
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i -= 1;
    if (i < 0) return;
    idx[i] += 1;
    for (let j = i + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
  }
}

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function publicCandidate(c) {
  const out = {
    number: c.number,
    branch: c.branch,
    bankId: c.bankId,
    ledgerIds: c.ledgerIds.slice(),
    fee: c.fee,
    status: c.status,
  };
  if (c.reason) out.reason = c.reason;
  return out;
}

class ReconEngine {
  constructor() {
    this.initialized = false;
    this.tolerance = 0;
    this.bank = new Map();
    this.ledger = new Map();
    this.candidates = [];
    this.matches = [];
    this.nextCandidateNumber = 1;
    this.nextMatchNumber = 1;
  }

  applyEvent(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new ReconError('INVALID_EVENT', 'event must be a plain object');
    }
    switch (event.type) {
      case 'init':
        return this.#init(event);
      case 'suggest':
        return this.#suggest();
      case 'confirm':
        return this.#confirm(event);
      case 'undo':
        return this.#undo(event);
      default:
        throw new ReconError('UNKNOWN_EVENT_TYPE', `unknown event type: ${String(event.type)}`);
    }
  }

  #init(event) {
    if (this.initialized) {
      throw new ReconError('ALREADY_INITIALIZED', 'init event may only be applied once');
    }
    if (!isInteger(event.tolerance) || event.tolerance < 0) {
      throw new ReconError('INVALID_TOLERANCE', 'tolerance must be a non-negative integer');
    }
    const load = (list, kind) => {
      if (!Array.isArray(list)) {
        throw new ReconError('INVALID_ENTRIES', `${kind}Entries must be an array`);
      }
      const map = new Map();
      for (const entry of list) {
        if (entry === null || typeof entry !== 'object'
            || typeof entry.id !== 'string' || entry.id.length === 0
            || !isInteger(entry.amount)) {
          throw new ReconError('INVALID_ENTRY', `${kind} entry must have a non-empty string id and an integer amount`);
        }
        if (map.has(entry.id)) {
          throw new ReconError('DUPLICATE_ENTRY_ID', `duplicate ${kind} entry id: ${entry.id}`);
        }
        map.set(entry.id, { id: entry.id, amount: entry.amount, status: 'unmatched' });
      }
      return map;
    };
    this.bank = load(event.bankEntries, 'bank');
    this.ledger = load(event.ledgerEntries, 'ledger');
    this.tolerance = event.tolerance;
    this.initialized = true;
    return {
      type: 'init',
      tolerance: this.tolerance,
      bankCount: this.bank.size,
      ledgerCount: this.ledger.size,
    };
  }

  #requireInitialized() {
    if (!this.initialized) {
      throw new ReconError('NOT_INITIALIZED', 'an init event is required before any other event');
    }
  }

  #suggest() {
    this.#requireInitialized();
    const lockedBank = new Set();
    const lockedLedger = new Set();
    for (const c of this.candidates) {
      if (c.status === 'suggested') {
        lockedBank.add(c.bankId);
        for (const id of c.ledgerIds) lockedLedger.add(id);
      }
    }
    const unmatchedBank = [...this.bank.values()].filter((e) => e.status === 'unmatched');
    const unmatchedLedger = [...this.ledger.values()].filter((e) => e.status === 'unmatched');
    const ledgerIds = unmatchedLedger.map((e) => e.id);
    const amounts = new Map(unmatchedLedger.map((e) => [e.id, e.amount]));
    const produced = [];
    for (const bankEntry of unmatchedBank) {
      for (const branch of ['exact', 'fee']) {
        for (let size = 1; size <= ledgerIds.length; size += 1) {
          for (const idxs of combinationIndices(ledgerIds.length, size)) {
            const combo = idxs.map((i) => ledgerIds[i]);
            const sum = combo.reduce((acc, id) => acc + amounts.get(id), 0);
            const diff = bankEntry.amount - sum;
            const ok = branch === 'exact'
              ? diff === 0
              : diff !== 0 && Math.abs(diff) <= this.tolerance;
            if (!ok) continue;
            const candidate = {
              number: this.nextCandidateNumber,
              branch,
              bankId: bankEntry.id,
              ledgerIds: combo,
              fee: branch === 'fee' ? diff : 0,
              status: 'suggested',
              reason: null,
            };
            this.nextCandidateNumber += 1;
            if (lockedBank.has(candidate.bankId) || combo.some((id) => lockedLedger.has(id))) {
              candidate.status = 'rejected';
              candidate.reason = 'conflict';
            } else {
              lockedBank.add(candidate.bankId);
              for (const id of combo) lockedLedger.add(id);
            }
            this.candidates.push(candidate);
            produced.push(candidate);
          }
        }
      }
    }
    return { type: 'suggest', candidates: produced.map(publicCandidate) };
  }

  #confirm(event) {
    this.#requireInitialized();
    if (!isInteger(event.candidate)) {
      throw new ReconError('INVALID_CANDIDATE', 'confirm event requires an integer "candidate" field');
    }
    const candidate = this.candidates.find((c) => c.number === event.candidate);
    if (!candidate) {
      throw new ReconError('CANDIDATE_NOT_FOUND', `no candidate with number ${event.candidate}`);
    }
    if (candidate.status !== 'suggested') {
      throw new ReconError(
        'CANDIDATE_NOT_CONFIRMABLE',
        `candidate ${event.candidate} has status "${candidate.status}" and cannot be confirmed`,
      );
    }
    const bankEntry = this.bank.get(candidate.bankId);
    const ledgerEntries = candidate.ledgerIds.map((id) => this.ledger.get(id));
    if (bankEntry.status !== 'unmatched' || ledgerEntries.some((e) => e.status !== 'unmatched')) {
      throw new ReconError('ENTRIES_UNAVAILABLE', `candidate ${event.candidate} references entries that are no longer unmatched`);
    }
    bankEntry.status = 'matched';
    for (const e of ledgerEntries) e.status = 'matched';
    candidate.status = 'confirmed';
    const match = {
      id: `M${this.nextMatchNumber}`,
      candidateNumber: candidate.number,
      bankId: candidate.bankId,
      ledgerIds: candidate.ledgerIds.slice(),
      fee: candidate.fee,
      status: 'active',
    };
    this.nextMatchNumber += 1;
    this.matches.push(match);
    return { type: 'confirm', match: match.id, candidate: candidate.number, fee: candidate.fee };
  }

  #undo(event) {
    this.#requireInitialized();
    if (typeof event.match !== 'string' || event.match.length === 0) {
      throw new ReconError('INVALID_MATCH', 'undo event requires a non-empty string "match" field');
    }
    const match = this.matches.find((m) => m.id === event.match);
    if (!match) {
      throw new ReconError('MATCH_NOT_FOUND', `no match with id ${event.match}`);
    }
    if (match.status !== 'active') {
      throw new ReconError('MATCH_NOT_ACTIVE', `match ${event.match} has status "${match.status}" and cannot be undone`);
    }
    match.status = 'undone';
    this.bank.get(match.bankId).status = 'unmatched';
    for (const id of match.ledgerIds) this.ledger.get(id).status = 'unmatched';
    const candidate = this.candidates.find((c) => c.number === match.candidateNumber);
    if (candidate) candidate.status = 'undone';
    return {
      type: 'undo',
      undone: match.id,
      released: { bank: [match.bankId], ledger: match.ledgerIds.slice() },
      feeRolledBack: match.fee,
    };
  }

  certificate() {
    const active = this.matches.filter((m) => m.status === 'active');
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    return {
      version: 1,
      tolerance: this.initialized ? this.tolerance : null,
      matches: active.map((m) => ({
        id: m.id,
        candidate: m.candidateNumber,
        bankId: m.bankId,
        ledgerIds: m.ledgerIds.slice(),
        fee: m.fee,
      })),
      unmatchedBank: [...this.bank.values()].filter((e) => e.status === 'unmatched').map((e) => e.id),
      unmatchedLedger: [...this.ledger.values()].filter((e) => e.status === 'unmatched').map((e) => e.id),
      feeCorrections: active.filter((m) => m.fee !== 0).map((m) => ({ matchId: m.id, amount: m.fee })),
      totals: {
        matchedBankAmount: sum(active.map((m) => this.bank.get(m.bankId).amount)),
        matchedLedgerAmount: sum(active.flatMap((m) => m.ledgerIds.map((id) => this.ledger.get(id).amount))),
        feeTotal: sum(active.map((m) => m.fee)),
      },
    };
  }

  stateHash() {
    return hashCertificate(this.certificate());
  }
}

function replay(events, expectedResults) {
  const engine = new ReconEngine();
  events.forEach((event, i) => {
    const result = engine.applyEvent(event);
    if (expectedResults && canonicalize(result) !== canonicalize(expectedResults[i])) {
      throw new ReconError('LOG_MISMATCH', `replayed event #${i + 1} does not match its persisted result`);
    }
  });
  return engine;
}

module.exports = {
  ReconEngine,
  ReconError,
  replay,
  canonicalize,
  hashCertificate,
  publicCandidate,
};
