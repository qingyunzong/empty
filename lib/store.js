'use strict';

const fs = require('node:fs');
const path = require('node:path');
const csv = require('./csv');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.stateDir = path.join(dir, 'state');
  }

  load() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.batches = this._readJson('batches.json');
    if (!this.batches) {
      this.batches = csv.parse(this._readText(path.join(this.dir, 'batches.csv'))).map((r) => ({
        batchId: r.batchId,
        parentId: r.parentId || null,
        layer: Number(r.layer),
        customerId: r.customerId,
        amount: Number(r.amount),
        currency: r.currency,
        date: r.date,
        status: r.status || 'active',
        budgetApplied: r.budgetApplied === 'true',
      }));
      this._writeJson('batches.json', this.batches);
    }
    this.receipts = csv.parse(this._readText(path.join(this.dir, 'bank.csv')));
    this.budgets = this._readJson('budgets.json') || { limits: {}, usage: {} };
    this.journal = this._readJson('journal.json') || { ops: [] };
    this._recover();
    return this;
  }

  saveBatches() {
    this._writeJson('batches.json', this.batches);
  }

  saveBudgets() {
    this._writeJson('budgets.json', this.budgets);
  }

  saveJournal() {
    this._writeJson('journal.json', this.journal);
  }

  _recover() {
    let batchesDirty = false;
    let journalDirty = false;
    for (const op of this.journal.ops) {
      if (op.status !== 'budget_updated') continue;
      const byId = new Map(this.batches.map((b) => [b.batchId, b]));
      if (op.type === 'rollback') {
        for (const id of op.rolledBack) {
          const b = byId.get(id);
          if (b && b.status !== 'rolled_back') {
            b.status = 'rolled_back';
            batchesDirty = true;
          }
        }
        for (const adj of op.adjustments) {
          if (!byId.has(adj.batchId)) {
            this.batches.push(adj);
            batchesDirty = true;
          }
        }
      } else if (op.type === 'apply') {
        for (const id of op.applied) {
          const b = byId.get(id);
          if (b && !b.budgetApplied) {
            b.budgetApplied = true;
            batchesDirty = true;
          }
        }
      }
      op.status = 'completed';
      journalDirty = true;
    }
    if (batchesDirty) this.saveBatches();
    if (journalDirty) this.saveJournal();
  }

  _readText(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  _readJson(name) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.stateDir, name), 'utf8'));
    } catch {
      return null;
    }
  }

  _writeJson(name, data) {
    const file = path.join(this.stateDir, name);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
}

module.exports = { Store };
