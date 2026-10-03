// Durable store: plan.tmp -> plan.json atomic rename, budget manifest commit,
// journal replay. Encapsulates the three crash points:
//   1. journal append        -> recovered by replaying complete records
//   2. plan.tmp rename       -> recovered by discarding the temporary plan
//   3. budget manifest commit -> recovered by keeping the committed manifest

import fs from 'node:fs';
import path from 'node:path';
import { Journal } from './journal.js';
import { stateToJSON, stateFromJSON } from './model.js';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.planFile = path.join(dir, 'plan.json');
    this.planTmp = path.join(dir, 'plan.tmp');
    this.journalFile = path.join(dir, 'journal.log');
    this.manifestFile = path.join(dir, 'budget.json');
    this.manifestTmp = path.join(dir, 'budget.tmp');
    this.journal = null;
  }

  // Open the store and run crash recovery.
  // Returns { snapshot, journalRecords, recovered } — the Workspace decides
  // how to combine snapshot + journal replay.
  open() {
    fs.mkdirSync(this.dir, { recursive: true });
    const recovered = { journalReplayed: 0, tmpPlanDiscarded: false, manifestKept: false };

    // Crash point 2: a leftover plan.tmp means a crash before/during rename.
    // The temporary plan is discarded; plan.json (if any) stays authoritative.
    if (fs.existsSync(this.planTmp)) {
      fs.rmSync(this.planTmp);
      recovered.tmpPlanDiscarded = true;
    }
    // A leftover budget.tmp means a crash before manifest commit: discard it,
    // the previously committed manifest (if any) remains in effect.
    if (fs.existsSync(this.manifestTmp)) {
      fs.rmSync(this.manifestTmp);
    }
    // Crash point 3: committed budget manifest is preserved as-is.
    if (fs.existsSync(this.manifestFile)) {
      recovered.manifestKept = true;
    }

    let snapshot = null;
    if (fs.existsSync(this.planFile)) {
      snapshot = stateFromJSON(JSON.parse(fs.readFileSync(this.planFile, 'utf8')));
    }

    // Crash point 1: journal records are returned for replay. Snapshots are
    // written only after journaling, so when a snapshot exists the journal is
    // a prefix log and can be truncated.
    const records = Journal.replay(this.journalFile);
    this.journal = new Journal(this.journalFile).open();
    if (snapshot && records.length > 0) {
      this.journal.close();
      fs.rmSync(this.journalFile);
      this.journal = new Journal(this.journalFile).open();
      recovered.journalReplayed = 0;
    } else if (!snapshot) {
      recovered.journalReplayed = records.length;
    }
    return { snapshot, journalRecords: snapshot ? [] : records, recovered };
  }

  // Atomic plan snapshot: write plan.tmp, fsync, rename over plan.json,
  // fsync the directory so the rename itself is durable.
  commitPlan(state) {
    const tmp = this.planTmp;
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(stateToJSON(state)));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, this.planFile);
    this.fsyncDir();
  }

  // Budget manifest commit: tmp + fsync + rename. Once rename returns, the
  // manifest is committed and survives crashes.
  commitManifest(manifest) {
    const fd = fs.openSync(this.manifestTmp, 'w');
    fs.writeSync(fd, JSON.stringify(manifest));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(this.manifestTmp, this.manifestFile);
    this.fsyncDir();
  }

  readManifest() {
    if (!fs.existsSync(this.manifestFile)) return null;
    return JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'));
  }

  fsyncDir() {
    const fd = fs.openSync(this.dir, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }

  close() {
    if (this.journal) this.journal.close();
  }
}
