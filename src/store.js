'use strict';

const fs = require('fs');
const path = require('path');
const { SchedError } = require('./errors');
const { solve, prepareInput, inputHashOf } = require('./scheduler');

const WAL_FILE = 'wal.log';
const META_FILE = 'meta.json';
const JOBS_FILE = 'jobs.json';
const INDEX_FILE = 'index.json';
const VERSIONS_DIR = 'versions';

// Crash injection points: 'after_stage' (staged plan is durable in the WAL but
// no commit marker exists -> recovery must discard it) and 'after_commit'
// (commit marker is durable -> recovery must make the new version visible).

function indexKey(jobId, deviceId) {
  return JSON.stringify([String(jobId), String(deviceId)]);
}

function writeFileAtomicSync(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

class Store {
  static open(dir, opts = {}) {
    fs.mkdirSync(path.join(dir, VERSIONS_DIR), { recursive: true });
    const store = new Store(dir);
    store.crashHook = opts.crashHook || null;
    store._recover();
    return store;
  }

  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, WAL_FILE);
    this.crashHook = null;
    this._txSeq = 0;
  }

  _crash(point) {
    if (this.crashHook) this.crashHook(point);
  }

  _appendWal(record) {
    const fd = fs.openSync(this.walPath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  _versionPath(version) {
    return path.join(this.dir, VERSIONS_DIR, `v-${version}.json`);
  }

  _recover() {
    const records = [];
    if (fs.existsSync(this.walPath)) {
      const content = fs.readFileSync(this.walPath, 'utf8');
      for (const line of content.split('\n')) {
        if (line.trim() === '') continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          break; // torn tail from a crashed append: ignore the rest
        }
        records.push(rec);
      }
    }
    let jobsState = { jobsVersion: 0, jobs: [], devices: null };
    const staged = new Map(); // txId -> plan
    let lastCommit = null;
    for (const rec of records) {
      if (rec.op === 'jobs') {
        jobsState = { jobsVersion: rec.version, jobs: rec.jobs, devices: rec.devices };
      } else if (rec.op === 'stage') {
        staged.set(rec.txId, rec.plan);
      } else if (rec.op === 'commit') {
        lastCommit = rec;
      }
    }
    this.jobsVersion = jobsState.jobsVersion;
    this.jobs = jobsState.jobs;
    this.devices = jobsState.devices;
    this.currentVersion = 0;
    this.currentPlan = null;
    if (lastCommit) {
      const plan = staged.get(lastCommit.txId);
      if (!plan) {
        throw new SchedError('E_CORRUPT', `commit ${lastCommit.txId} has no staged plan in the WAL`);
      }
      this.currentVersion = lastCommit.version;
      this.currentPlan = { ...plan, version: lastCommit.version };
      // Materialize the committed version file; a crash between the commit
      // marker and the version-file write is repaired here from the WAL.
      writeFileAtomicSync(this._versionPath(lastCommit.version), JSON.stringify(this.currentPlan, null, 2));
    }
    this._persistMeta();
    writeFileAtomicSync(
      path.join(this.dir, JOBS_FILE),
      JSON.stringify({ jobsVersion: this.jobsVersion, jobs: this.jobs, devices: this.devices }, null, 2)
    );
    this._rebuildIndex();
  }

  _persistMeta() {
    writeFileAtomicSync(
      path.join(this.dir, META_FILE),
      JSON.stringify({ jobsVersion: this.jobsVersion, currentVersion: this.currentVersion }, null, 2)
    );
  }

  _rebuildIndex() {
    // Secondary index on (jobId, deviceId) for the currently visible plan.
    this.index = new Map();
    if (this.currentPlan) {
      for (const [deviceId, ops] of Object.entries(this.currentPlan.schedule)) {
        ops.forEach((op, position) => {
          this.index.set(indexKey(op.jobId, deviceId), {
            version: this.currentVersion,
            jobId: op.jobId,
            deviceId,
            start: op.start,
            end: op.end,
            position,
          });
        });
      }
    }
    const obj = {};
    for (const [key, entry] of this.index) obj[key] = entry;
    writeFileAtomicSync(path.join(this.dir, INDEX_FILE), JSON.stringify(obj, null, 2));
  }

  lookup(jobId, deviceId) {
    return this.index.get(indexKey(jobId, deviceId)) || null;
  }

  getJobs() {
    return { jobsVersion: this.jobsVersion, jobs: this.jobs, devices: this.devices };
  }

  setJobs(input) {
    const { jobs, devices } = prepareInput(input);
    const version = this.jobsVersion + 1;
    this._appendWal({ op: 'jobs', version, jobs, devices });
    this.jobsVersion = version;
    this.jobs = jobs;
    this.devices = devices;
    writeFileAtomicSync(
      path.join(this.dir, JOBS_FILE),
      JSON.stringify({ jobsVersion: version, jobs, devices }, null, 2)
    );
    this._persistMeta();
    return version;
  }

  beginPlan() {
    this._txSeq += 1;
    return {
      txId: `tx-${this.jobsVersion}-${this.currentVersion}-${this._txSeq}`,
      baseJobsVersion: this.jobsVersion,
      baseJobsHash: inputHashOf({ jobs: this.jobs, devices: this.devices }),
      staged: null,
    };
  }

  stage(tx, plan) {
    this._appendWal({ op: 'stage', txId: tx.txId, plan });
    tx.staged = plan;
    this._crash('after_stage');
  }

  commit(tx) {
    if (!tx.staged) throw new SchedError('E_INVALID', 'transaction has no staged plan');
    const currentHash = inputHashOf({ jobs: this.jobs, devices: this.devices });
    if (tx.baseJobsVersion !== this.jobsVersion || tx.baseJobsHash !== currentHash) {
      throw new SchedError(
        'E_SNAPSHOT',
        `job set changed during planning: transaction read jobsVersion ${tx.baseJobsVersion}, current is ${this.jobsVersion}`,
        { baseJobsVersion: tx.baseJobsVersion, currentJobsVersion: this.jobsVersion }
      );
    }
    const version = this.currentVersion + 1;
    this._appendWal({ op: 'commit', txId: tx.txId, version });
    this._crash('after_commit');
    const plan = { ...tx.staged, version };
    writeFileAtomicSync(this._versionPath(version), JSON.stringify(plan, null, 2));
    this.currentVersion = version;
    this.currentPlan = plan;
    this._persistMeta();
    this._rebuildIndex();
    return version;
  }

  current() {
    return this.currentPlan ? { version: this.currentVersion, plan: this.currentPlan } : null;
  }

  // Stage + commit a freshly computed plan in one transaction. Throws
  // E_INFEASIBLE before anything is staged when no feasible plan exists, so a
  // failed replan never touches the previously committed version.
  planAndCommit() {
    const tx = this.beginPlan();
    const result = solve({ jobs: this.jobs, devices: this.devices });
    const plan = { jobsVersion: this.jobsVersion, ...result };
    this.stage(tx, plan);
    const version = this.commit(tx);
    return { version, plan: this.currentPlan };
  }
}

module.exports = { Store };
