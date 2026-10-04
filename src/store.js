'use strict';
// Persistence: append-only event log (source of truth) + atomically replaced
// cluster index. A crash mid index-write leaves a partial *.tmp file and a
// stale-but-valid index.json; recovery discards the tmp and rebuilds from the
// event log, so no cluster is ever duplicated or lost.

const fs = require('node:fs');
const path = require('node:path');

// Thrown where a real deployment would die mid-write (power loss, SIGKILL).
// The bin wrapper translates it into a non-zero exit without cleanup.
class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash during cluster index write');
    this.name = 'SimulatedCrash';
  }
}

class Store {
  constructor(dir, options = {}) {
    this.fault = options.fault || null;
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.logPath = path.join(dir, 'events.jsonl');
    this.indexPath = path.join(dir, 'clusters.json');
    this.tmpPath = this.indexPath + '.tmp';
  }

  loadEvents() {
    if (!fs.existsSync(this.logPath)) return [];
    return fs
      .readFileSync(this.logPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  appendEvent(event) {
    fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n');
    const fd = fs.openSync(this.logPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  // Returns the persisted index, or null when missing/corrupt. A leftover
  // partial tmp from a crashed write is discarded here.
  loadIndex() {
    if (fs.existsSync(this.tmpPath)) fs.rmSync(this.tmpPath, { force: true });
    if (!fs.existsSync(this.indexPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.clusterIds)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  // Atomic write via tmp + rename. fault 'index-write' simulates a crash in
  // the middle of the write: partial tmp, no rename, abrupt abort.
  writeIndex(index) {
    const data = JSON.stringify(index, null, 2);
    if (this.fault === 'index-write') {
      fs.writeFileSync(this.tmpPath, data.slice(0, Math.floor(data.length / 2)));
      throw new SimulatedCrash();
    }
    fs.writeFileSync(this.tmpPath, data);
    const fd = fs.openSync(this.tmpPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.tmpPath, this.indexPath);
  }
}

module.exports = { Store, SimulatedCrash };
