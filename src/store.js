'use strict';

const fs = require('node:fs');
const path = require('node:path');

// File-backed journal with explicit failure points:
//   1. crash after `plan` record but before `commit` record -> plan discarded on recovery
//   2. crash after `commit` record -> plan is replayed on recovery; replay must be idempotent
// State snapshot (state.json) is a cache only; the journal is the source of truth.
class JournalStore {
  constructor(dir) {
    this.dir = dir;
    this.journalPath = path.join(dir, 'journal.log');
    this.statePath = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.journalPath)) fs.writeFileSync(this.journalPath, '');
  }

  append(record) {
    const line = JSON.stringify(record) + '\n';
    const fd = fs.openSync(this.journalPath, 'a');
    try {
      fs.writeFileSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  writePlan(plan) {
    this.append({ op: 'plan', planId: plan.planId, plan });
  }

  writeCommit(planId) {
    this.append({ op: 'commit', planId });
  }

  // Returns committed plans in journal order. Uncommitted plans are discarded.
  readCommittedPlans() {
    const raw = fs.readFileSync(this.journalPath, 'utf8');
    const plans = new Map();
    const committed = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // torn tail write: ignore partial last line
      }
      if (record.op === 'plan') {
        plans.set(record.planId, record.plan);
      } else if (record.op === 'commit' && plans.has(record.planId)) {
        committed.push(plans.get(record.planId));
      }
    }
    return committed;
  }

  saveState(state) {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.statePath);
  }

  loadState() {
    if (!fs.existsSync(this.statePath)) return null;
    return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
  }
}

module.exports = { JournalStore };
