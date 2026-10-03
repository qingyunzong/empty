import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lotKey, GENESIS_HASH } from '../src/store.js';
import { judgeValue } from '../src/judge.js';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qms-test-'));
}

export class SimulatedCrash extends Error {
  constructor(point) {
    super(`simulated crash after ${point}`);
    this.point = point;
  }
}

export function crashAt(point, { times = 1 } = {}) {
  let remaining = times;
  return (p) => {
    if (p === point && remaining > 0) {
      remaining -= 1;
      throw new SimulatedCrash(p);
    }
  };
}

export function referenceReplay(dir) {
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
  const walPath = path.join(dir, 'wal.log');
  const state = {
    seq: 0,
    headHash: GENESIS_HASH,
    records: {},
    byClientId: {},
    latest: {},
    ngStreak: {}
  };
  if (!fs.existsSync(walPath)) {
    return state;
  }
  const raw = fs.readFileSync(walPath, 'utf8');
  if (raw.length === 0) {
    return state;
  }
  const lines = raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
  let pending = null;
  const committed = [];
  for (const line of lines) {
    if (line.kind === 'data') {
      pending = line;
    } else if (line.kind === 'commit') {
      if (pending && line.seq === pending.seq && line.hash === pending.hash) {
        committed.push(pending);
      }
      pending = null;
    }
  }
  committed.sort((a, b) => a.seq - b.seq);
  for (const entry of committed) {
    const { record } = entry;
    const item = catalog[record.testCode];
    const key = lotKey(record.lotId, record.testCode);
    const { judgment, ngStreak } = judgeValue(item, record.value, state.ngStreak[key] ?? 0);
    state.records[entry.recordId] = {
      seq: entry.seq,
      recordId: entry.recordId,
      prevHash: entry.prevHash,
      hash: entry.hash,
      record,
      judgment
    };
    state.byClientId[record.clientRecordId] = entry.recordId;
    state.latest[key] = entry.recordId;
    state.ngStreak[key] = ngStreak;
    state.seq = entry.seq;
    state.headHash = entry.hash;
  }
  return state;
}
