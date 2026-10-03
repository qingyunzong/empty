'use strict';

const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine');

class SimulatedCrashError extends Error {
  constructor() {
    super('simulated crash during cluster index write');
    this.name = 'SimulatedCrashError';
  }
}

function paths(dir) {
  return {
    snapshot: path.join(dir, 'snapshot.json'),
    clusters: path.join(dir, 'clusters.json'),
    journal: path.join(dir, 'journal.jsonl'),
    manifest: path.join(dir, 'manifest.json'),
  };
}

// Atomic write via tmp file + fsync + rename. fault='mid-write' simulates a
// crash in the middle of writing the cluster index: a partial tmp file is left
// behind and the rename never happens.
function writeAtomic(file, contents, opts = {}) {
  const tmp = file + '.tmp';
  if (opts.fault === 'mid-write') {
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, contents.slice(0, Math.floor(contents.length / 2)));
    fs.closeSync(fd);
    throw new SimulatedCrashError();
  }
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, contents);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

function appendJournal(dir, seq, event) {
  fs.appendFileSync(paths(dir).journal, JSON.stringify({ seq, event }) + '\n');
}

function commit(dir, engine, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const p = paths(dir);
  const seq = engine.seq;
  writeAtomic(p.snapshot, JSON.stringify(engine.toSnapshot()));
  writeAtomic(p.clusters, JSON.stringify({ seq, clusters: engine.getAllClusters() }), {
    fault: opts.faultAt === 'clusters' ? 'mid-write' : undefined,
  });
  writeAtomic(p.manifest, JSON.stringify({ snapshotSeq: seq, clusterSeq: seq }));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Recovery: snapshot + journal are the source of truth; the cluster index is a
// derived artifact. A torn cluster index (partial tmp, stale or missing
// clusters.json, manifest mismatch) triggers a deterministic rebuild, which
// reproduces identical content-hashed cluster ids — never duplicates.
function recover(dir) {
  const p = paths(dir);
  const manifest = readJson(p.manifest);
  const snapshot = readJson(p.snapshot);
  let engine;
  let baseSeq = 0;
  if (snapshot && (!manifest || manifest.snapshotSeq === snapshot.seq)) {
    engine = Engine.fromSnapshot(snapshot);
    baseSeq = snapshot.seq;
  } else {
    engine = new Engine();
  }
  let journaledSeq = 0;
  if (fs.existsSync(p.journal)) {
    for (const line of fs.readFileSync(p.journal, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      journaledSeq = Math.max(journaledSeq, rec.seq);
      if (rec.seq > baseSeq) engine.apply(rec.event);
    }
  }
  const cidx = readJson(p.clusters);
  const indexValid =
    cidx && manifest && manifest.clusterSeq === cidx.seq && cidx.seq === engine.seq;
  if (!indexValid) {
    engine.recomputeAll();
    commit(dir, engine);
  }
  return { engine, journaledSeq, indexRebuilt: !indexValid };
}

module.exports = {
  SimulatedCrashError,
  paths,
  writeAtomic,
  appendJournal,
  commit,
  recover,
};
