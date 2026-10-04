import fs from 'node:fs';
import path from 'node:path';
import { ScheduleError, normalizeDevices, normalizeJobs } from './scheduler.js';

const WAL_FILE = 'wal.log';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, WAL_FILE);
    this.fd = null;
    this.version = 0;
    this.jobsVersion = 0;
    this.planVersion = 0;
    this.jobs = [];
    this.devices = normalizeDevices(undefined);
    this.plan = null;
    this.index = new Map();
    this.txCounter = 0;
    this.openEpoch = Date.now();
  }

  static open(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    store._recover();
    store.fd = fs.openSync(store.walPath, 'a');
    return store;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  _recover() {
    if (!fs.existsSync(this.walPath)) return;
    const raw = fs.readFileSync(this.walPath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    const pending = new Map();
    for (let i = 0; i < lines.length; i += 1) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        if (i === lines.length - 1) break; // torn tail from crash mid-write
        throw new Error(`corrupt WAL at line ${i + 1}`);
      }
      this._apply(rec, pending);
    }
  }

  _apply(rec, pending) {
    switch (rec.type) {
      case 'jobs':
        this.jobs = rec.jobs;
        this.devices = rec.devices;
        this.jobsVersion = rec.jobsVersion;
        this.version = rec.version;
        break;
      case 'plan_stage':
        pending.set(rec.txId, rec);
        break;
      case 'plan_commit': {
        const staged = pending.get(rec.txId);
        if (staged) {
          this.plan = staged.plan;
          this.planVersion = rec.planVersion;
          this.version = rec.version;
          this._rebuildIndex();
        }
        break;
      }
      default:
        throw new Error(`unknown WAL record type: ${rec.type}`);
    }
  }

  _append(rec) {
    fs.writeSync(this.fd, `${JSON.stringify(rec)}\n`);
    fs.fsyncSync(this.fd);
  }

  _rebuildIndex() {
    this.index = new Map();
    if (!this.plan) return;
    for (const entry of this.plan.entries) {
      this.index.set(`${entry.jobId} ${entry.deviceId}`, {
        jobId: entry.jobId,
        deviceId: entry.deviceId,
        start: entry.start,
        end: entry.end,
        planVersion: this.planVersion,
      });
    }
  }

  getState() {
    return {
      version: this.version,
      jobsVersion: this.jobsVersion,
      planVersion: this.planVersion,
      devices: this.devices.slice(),
      jobs: this.jobs.map((j) => ({ ...j, devices: j.devices.slice() })),
      plan: this.plan ? JSON.parse(JSON.stringify(this.plan)) : null,
    };
  }

  setJobs(inputJobs, inputDevices) {
    const devices = inputDevices === undefined ? this.devices : normalizeDevices(inputDevices);
    const jobs = normalizeJobs(inputJobs, devices);
    const rec = {
      type: 'jobs',
      version: this.version + 1,
      jobsVersion: this.jobsVersion + 1,
      devices,
      jobs,
    };
    this._append(rec);
    this._apply(rec, new Map());
    return { version: this.version, jobsVersion: this.jobsVersion };
  }

  begin() {
    this.txCounter += 1;
    return {
      txId: `tx-${this.openEpoch}-${this.version + 1}-${this.txCounter}`,
      jobsVersion: this.jobsVersion,
      jobs: this.jobs.map((j) => ({ ...j, devices: j.devices.slice() })),
      devices: this.devices.slice(),
      staged: false,
      closed: false,
      plan: null,
    };
  }

  stage(tx, plan) {
    this._assertTx(tx);
    if (tx.staged) throw new ScheduleError('E_TX', 'plan already staged in this transaction');
    this._append({ type: 'plan_stage', txId: tx.txId, baseVersion: tx.jobsVersion, plan });
    tx.staged = true;
    tx.plan = plan;
    return { staged: true, baseVersion: tx.jobsVersion };
  }

  commit(tx) {
    this._assertTx(tx);
    if (!tx.staged) throw new ScheduleError('E_TX', 'no staged plan in this transaction');
    if (tx.jobsVersion !== this.jobsVersion) {
      tx.closed = true;
      throw new ScheduleError(
        'E_SNAPSHOT',
        `staged plan is based on jobs version ${tx.jobsVersion}, current is ${this.jobsVersion}`,
        { expected: tx.jobsVersion, actual: this.jobsVersion },
      );
    }
    const rec = {
      type: 'plan_commit',
      txId: tx.txId,
      version: this.version + 1,
      planVersion: this.planVersion + 1,
    };
    this._append(rec);
    this.plan = tx.plan;
    this.planVersion = rec.planVersion;
    this.version = rec.version;
    this._rebuildIndex();
    tx.closed = true;
    return { version: this.version, planVersion: this.planVersion };
  }

  lookup(jobId, deviceId) {
    return this.index.get(`${jobId} ${deviceId}`) ?? null;
  }

  _assertTx(tx) {
    if (!tx || tx.closed) throw new ScheduleError('E_TX', 'transaction is closed');
  }
}
