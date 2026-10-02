import fs from 'node:fs';
import path from 'node:path';
import { E } from './errors.js';
import { SimulatedCrash } from './errors.js';

// WAL-backed ledger store.
//
// Write protocol (WAL is written ONLY at these points):
//   1. BEGIN_BATCH  -> wal.log, then index marks batch IN_FLIGHT, dirty=true
//   2. before each POST -> wal.log POST record, then posts.jsonl append,
//      then index update (balances + post id)
//   3. END_BATCH    -> wal.log, then index marks batch COMMITTED, dirty=false
//
// Defined crash point: POST record is durable in posts.jsonl but the index
// update has not happened. Recovery replays that POST from the WAL and
// repairs the index. Replay is idempotent (post ids are unique), so a
// repeated recover neither double-posts nor loses entries. Batches with
// BEGIN but no END remain IN_FLIGHT -- never silently treated as failed.
//
// Test hooks (env): JE_CRASH_AFTER_WAL=N, JE_CRASH_AFTER_POST=N kill the
// process after the Nth WAL-POST write / Nth posts.jsonl append.

const DEFAULT_INDEX = () => ({ posts: {}, balances: {}, batches: {}, dirty: false, closedPeriods: [] });

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.walPath = path.join(dir, 'wal.log');
    this.postsPath = path.join(dir, 'posts.jsonl');
    this.indexPath = path.join(dir, 'index.json');
    this.index = fs.existsSync(this.indexPath)
      ? JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
      : DEFAULT_INDEX();
    this.postsWritten = 0;
  }

  saveIndex() {
    fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2));
  }

  wal(record) {
    fs.appendFileSync(this.walPath, JSON.stringify(record) + '\n');
  }

  assertPeriodOpen(period) {
    if (this.index.closedPeriods.includes(period)) {
      throw E.period(`period '${period}' is closed`);
    }
  }

  closePeriod(period) {
    if (!this.index.closedPeriods.includes(period)) {
      this.index.closedPeriods.push(period);
      this.saveIndex();
    }
  }

  beginBatch(id, period) {
    if (this.index.dirty) {
      throw E.crash(`database at '${this.dir}' was not shut down cleanly; run 'je recover --db ${this.dir}' first`);
    }
    this.assertPeriodOpen(period);
    if (this.index.batches[id]) throw E.compile(`duplicate batch id '${id}'`);
    this.wal({ type: 'BEGIN_BATCH', id, period });
    this.index.batches[id] = { status: 'IN_FLIGHT', period };
    this.index.dirty = true;
    this.saveIndex();
  }

  post(batchId, seq, period, lines) {
    const record = { type: 'POST', batch: batchId, seq, period, lines };
    this.wal(record);
    crashHook('JE_CRASH_AFTER_WAL', this.postsWritten + 1);
    const id = `${batchId}:${seq}`;
    fs.appendFileSync(this.postsPath, JSON.stringify({ id, batch: batchId, seq, period, lines }) + '\n');
    this.postsWritten += 1;
    crashHook('JE_CRASH_AFTER_POST', this.postsWritten);
    this.applyPostToIndex(id, period, lines);
    this.saveIndex();
  }

  applyPostToIndex(id, period, lines) {
    if (this.index.posts[id]) return false; // idempotent: never double-post
    this.index.posts[id] = true;
    const bal = (this.index.balances[period] ||= {});
    for (const l of lines) {
      bal[l.account] = (bal[l.account] || 0) + (l.dc === 'D' ? l.amount : -l.amount);
    }
    return true;
  }

  endBatch(id) {
    this.wal({ type: 'END_BATCH', id });
    this.index.batches[id].status = 'COMMITTED';
    this.index.dirty = Object.values(this.index.batches).some((b) => b.status === 'IN_FLIGHT');
    this.saveIndex();
  }

  recover() {
    const walRecords = [];
    if (fs.existsSync(this.walPath)) {
      const raw = fs.readFileSync(this.walPath, 'utf8').split('\n').filter(Boolean);
      raw.forEach((line, i) => {
        try {
          walRecords.push(JSON.parse(line));
        } catch {
          throw E.replay(`corrupt WAL record at line ${i + 1} of ${this.walPath}`);
        }
      });
    }

    const postsOnDisk = new Map();
    if (fs.existsSync(this.postsPath)) {
      for (const line of fs.readFileSync(this.postsPath, 'utf8').split('\n').filter(Boolean)) {
        const p = JSON.parse(line);
        postsOnDisk.set(p.id, p);
      }
    }

    let replayed = 0;
    const begun = new Map();
    const ended = new Set();

    for (const rec of walRecords) {
      if (rec.type === 'BEGIN_BATCH') {
        begun.set(rec.id, rec);
        this.index.batches[rec.id] ||= { status: 'IN_FLIGHT', period: rec.period };
      } else if (rec.type === 'END_BATCH') {
        ended.add(rec.id);
      } else if (rec.type === 'POST') {
        const id = `${rec.batch}:${rec.seq}`;
        const existing = postsOnDisk.get(id);
        if (existing) {
          if (JSON.stringify(existing.lines) !== JSON.stringify(rec.lines)) {
            throw E.replay(`post '${id}' content mismatch between WAL and posts.jsonl`);
          }
        } else {
          fs.appendFileSync(this.postsPath, JSON.stringify({ id, batch: rec.batch, seq: rec.seq, period: rec.period, lines: rec.lines }) + '\n');
          postsOnDisk.set(id, rec);
          replayed += 1;
        }
        if (this.applyPostToIndex(id, rec.period, rec.lines)) replayed += 1;
      } else {
        throw E.replay(`unknown WAL record type '${rec.type}'`);
      }
    }

    for (const [id, rec] of begun) {
      this.index.batches[id] = { status: ended.has(id) ? 'COMMITTED' : 'IN_FLIGHT', period: rec.period };
    }
    this.index.dirty = false;
    this.saveIndex();

    const inFlight = Object.entries(this.index.batches)
      .filter(([, b]) => b.status === 'IN_FLIGHT')
      .map(([id]) => id);
    return { replayed, inFlight };
  }

  balances(period) {
    if (period !== undefined) return this.index.balances[period] || {};
    return this.index.balances;
  }

  batchStatus() {
    return this.index.batches;
  }
}

function crashHook(envVar, count) {
  const n = Number(process.env[envVar]);
  if (n && count === n) {
    if (process.env.JE_CRASH_MODE === 'throw') {
      throw new SimulatedCrash(`simulated crash at ${envVar}=${n}`);
    }
    process.exit(97); // simulated crash: no cleanup, no further writes
  }
}
