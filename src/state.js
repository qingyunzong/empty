'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RiskError, CODES } = require('./errors');

const DEFAULT_QUOTA = 1000000;

// Local state store with journaled apply, undo, and crash recovery.
//
// Layout inside the state directory:
//   state.json    committed state: { accounts: {id:{quota,frozen}}, history: [...] }
//   journal.json  in-flight apply: { batchId, decisions, deltas, checkpoint }
//
// Apply protocol and explicit fault points:
//   FP1: crash before the decision journal is written
//   FP2: crash after decisions written, before checkpoint
//   FP3: crash after checkpoint, before commit
// Quota is only mutated inside the atomic commit (tmp file + rename), and
// recovery reconciles the journal against committed history, so a retried
// apply never deducts quota twice. Rejected transactions never freeze quota.

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

class StateStore {
  constructor(dir) {
    this.dir = dir;
    this.statePath = path.join(dir, 'state.json');
    this.journalPath = path.join(dir, 'journal.json');
    this.tmpPath = path.join(dir, 'state.json.tmp');
  }

  loadState() {
    if (!fs.existsSync(this.statePath)) return { accounts: {}, history: [] };
    return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
  }

  saveStateAtomic(state) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.tmpPath, JSON.stringify(state));
    fs.renameSync(this.tmpPath, this.statePath);
  }

  writeJournal(journal) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.journalPath, JSON.stringify(journal));
  }

  readJournal() {
    if (!fs.existsSync(this.journalPath)) return null;
    return JSON.parse(fs.readFileSync(this.journalPath, 'utf8'));
  }

  ensureAccounts(state, txs) {
    for (const tx of txs) {
      if (!state.accounts[tx.account]) {
        state.accounts[tx.account] = { quota: DEFAULT_QUOTA, frozen: 0 };
      }
    }
  }

  // decisions: output of engine.evaluate(); faultPoint: 'FP1'|'FP2'|'FP3'|null
  apply(batchId, txs, decisions, faultPoint = null) {
    if (fs.existsSync(this.journalPath)) {
      throw new RiskError(
        CODES.APPLY_CONFLICT,
        'unfinished apply journal exists; run recover before applying'
      );
    }
    const state = this.loadState();
    if (state.history.some((h) => h.batchId === batchId)) {
      throw new RiskError(CODES.APPLY_CONFLICT, `batch ${batchId} already applied`);
    }
    this.ensureAccounts(state, txs);

    // Funds check happens before journaling: an approved transaction that
    // exceeds available quota becomes a failed transaction and freezes nothing.
    const deltas = {};
    const finalDecisions = decisions.map((d) => ({ ...d }));
    for (let i = 0; i < txs.length; i++) {
      if (finalDecisions[i].decision !== 'APPROVE') continue;
      const acct = state.accounts[txs[i].account];
      const available = acct.quota - acct.frozen - (deltas[txs[i].account] || 0);
      if (txs[i].amount > available) {
        finalDecisions[i].decision = 'REJECT';
        finalDecisions[i].rules = [...finalDecisions[i].rules, 'INSUFFICIENT_FUNDS'];
        continue;
      }
      deltas[txs[i].account] = (deltas[txs[i].account] || 0) + txs[i].amount;
    }

    const fault = (fp) => {
      if (faultPoint === fp) {
        throw new RiskError(CODES.FAULT_INJECTED, `simulated crash at ${fp}`);
      }
    };

    fault('FP1'); // before writing decisions
    this.writeJournal({ batchId, decisions: finalDecisions, deltas, checkpoint: false });
    fault('FP2'); // after decisions written, before checkpoint
    this.writeJournal({ batchId, decisions: finalDecisions, deltas, checkpoint: true });
    fault('FP3'); // after checkpoint, before commit

    // Commit: mutate quota and append history in one atomic state write.
    for (const [acct, amt] of Object.entries(deltas)) state.accounts[acct].frozen += amt;
    state.history.push({ batchId, deltas });
    this.saveStateAtomic(state);
    fs.unlinkSync(this.journalPath);
    return { decisions: finalDecisions, state };
  }

  // Reconcile after a crash. Idempotent; never deducts quota twice.
  recover() {
    const journal = this.readJournal();
    if (fs.existsSync(this.tmpPath)) fs.unlinkSync(this.tmpPath);
    if (!journal) return { recovered: false };
    const state = this.loadState();
    if (state.history.some((h) => h.batchId === journal.batchId)) {
      // Commit landed before the crash; only the journal cleanup was lost.
      fs.unlinkSync(this.journalPath);
      return { recovered: true, action: 'finalize', batchId: journal.batchId };
    }
    // Commit never landed: discard the journal; quota is untouched.
    fs.unlinkSync(this.journalPath);
    return { recovered: true, action: 'rollback', batchId: journal.batchId };
  }

  undo() {
    const state = this.loadState();
    if (state.history.length === 0) {
      throw new RiskError(CODES.UNDO_EMPTY, 'nothing to undo: apply history is empty');
    }
    const last = state.history.pop();
    for (const [acct, amt] of Object.entries(last.deltas)) {
      state.accounts[acct].frozen -= amt;
    }
    this.saveStateAtomic(state);
    return { undone: last.batchId, state };
  }

  stateHash() {
    const state = this.loadState();
    return crypto.createHash('sha256').update(stableStringify(state)).digest('hex');
  }
}

module.exports = { StateStore, DEFAULT_QUOTA, stableStringify };
