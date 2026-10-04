'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const journal = require('./journal');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// On-disk layout per terminal directory:
//   journal.log     append-only op log (fault point 1: torn append)
//   plan.json       last persisted plan, written via plan.tmp + rename
//                   (fault point 2: orphan plan.tmp is discarded on recovery)
//   budget.json     budget manifest (shift capacities + mold lives)
//   budget.commit   commit marker {hash, budget}; recovery keeps the last
//                   committed budget and rolls back uncommitted writes
//                   (fault point 3)
//   meta.json       terminal identity {termId, counter, batch}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.journalFile = path.join(dir, 'journal.log');
    this.planFile = path.join(dir, 'plan.json');
    this.planTmp = path.join(dir, 'plan.tmp');
    this.budgetFile = path.join(dir, 'budget.json');
    this.budgetTmp = path.join(dir, 'budget.tmp');
    this.budgetCommit = path.join(dir, 'budget.commit');
    this.metaFile = path.join(dir, 'meta.json');
  }

  appendOp(op) {
    journal.appendOp(this.journalFile, op);
  }

  rewriteJournal(ops) {
    const tmp = this.journalFile + '.tmp';
    const body = ops.map((o) => JSON.stringify(o)).join('\n');
    fs.writeFileSync(tmp, body + (ops.length ? '\n' : ''));
    fs.renameSync(tmp, this.journalFile);
  }

  savePlan(plan) {
    fs.writeFileSync(this.planTmp, JSON.stringify(plan, null, 2));
    fs.renameSync(this.planTmp, this.planFile);
  }

  loadPlan() {
    if (!fs.existsSync(this.planFile)) return null;
    return JSON.parse(fs.readFileSync(this.planFile, 'utf8'));
  }

  commitBudget(manifest) {
    const body = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(this.budgetTmp, body);
    fs.renameSync(this.budgetTmp, this.budgetFile);
    const commit = JSON.stringify({ hash: sha256(body), budget: manifest }, null, 2);
    fs.writeFileSync(this.budgetCommit + '.tmp', commit);
    fs.renameSync(this.budgetCommit + '.tmp', this.budgetCommit);
  }

  budgetStatus() {
    if (!fs.existsSync(this.budgetCommit)) {
      return { committed: false, ok: !fs.existsSync(this.budgetFile) };
    }
    const commit = JSON.parse(fs.readFileSync(this.budgetCommit, 'utf8'));
    if (!fs.existsSync(this.budgetFile)) return { committed: true, ok: false };
    const body = fs.readFileSync(this.budgetFile, 'utf8');
    return { committed: true, ok: sha256(body) === commit.hash };
  }

  recover() {
    const report = {};
    const j = journal.readOps(this.journalFile);
    report.journalTruncated = j.truncated;
    report.ops = j.ops;
    if (fs.existsSync(this.planTmp)) {
      fs.unlinkSync(this.planTmp);
      report.planTmpDiscarded = true;
    }
    if (fs.existsSync(this.budgetTmp)) fs.unlinkSync(this.budgetTmp);
    report.budget = null;
    if (fs.existsSync(this.budgetCommit)) {
      const commit = JSON.parse(fs.readFileSync(this.budgetCommit, 'utf8'));
      const committedBody = JSON.stringify(commit.budget, null, 2);
      const current = fs.existsSync(this.budgetFile)
        ? fs.readFileSync(this.budgetFile, 'utf8')
        : null;
      if (current === null || sha256(current) !== commit.hash) {
        fs.writeFileSync(this.budgetFile, committedBody);
        report.budgetRestored = current !== null;
      }
      report.budget = commit.budget;
    } else if (fs.existsSync(this.budgetFile)) {
      fs.unlinkSync(this.budgetFile);
      report.budgetDiscarded = true;
    }
    return report;
  }

  loadMeta() {
    if (!fs.existsSync(this.metaFile)) return null;
    return JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
  }

  saveMeta(meta) {
    const tmp = this.metaFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, this.metaFile);
  }
}

module.exports = { Store, sha256 };
