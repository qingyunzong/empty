'use strict';

const fs = require('node:fs');
const { Monitor } = require('./monitor');
const {
  genesisHash,
  chainHash,
  WalWriter,
  writeCheckpoint,
  recover,
} = require('./wal');

// Engine ties the monitor to the WAL and checkpoint files. Write order per
// batch: apply in memory -> append WAL record (write + fsync). Checkpoints
// are written only on explicit request, so a crash can leave the WAL ahead
// of the checkpoint -- the exact fault point recovery is built for.
class Engine {
  constructor({ walPath, chkPath, pattern, monitor, seq, hash }) {
    this.walPath = walPath;
    this.chkPath = chkPath;
    this.pattern = pattern;
    this.monitor = monitor;
    this.seq = seq;
    this.hash = hash;
    this.wal = new WalWriter(walPath);
  }

  static open({ walPath, chkPath, pattern }) {
    const rec = recover({ walPath, chkPath, pattern });
    return new Engine({
      walPath,
      chkPath,
      pattern,
      monitor: rec.monitor,
      seq: rec.seq,
      hash: rec.hash,
      replayed: rec.replayed,
    });
  }

  batch(events) {
    const applied = this.monitor.applyBatch(events);
    const ordered = applied.order.map((id) => events.find((e) => String(e.id) === String(id)));
    this.seq += 1;
    this.hash = chainHash(this.hash, this.seq, ordered, this.monitor.snapshot());
    this.wal.append({ seq: this.seq, events: ordered.map((e) => ({ id: e.id, type: e.type })), hash: this.hash });
    return {
      seq: this.seq,
      state: this.monitor.verdict(),
      ambiguous: applied.ambiguous,
      hash: this.hash,
    };
  }

  checkpoint() {
    writeCheckpoint(this.chkPath, {
      seq: this.seq,
      hash: this.hash,
      pattern: this.pattern,
      monitor: this.monitor.snapshot(),
    });
    return { seq: this.seq, hash: this.hash };
  }

  // Simulate a crash: drop all in-memory state (optionally leaving a torn
  // partial record at the WAL tail), then recover from disk.
  crash({ torn = false } = {}) {
    this.wal.close();
    if (torn) {
      fs.appendFileSync(this.walPath, '{"seq":999,"events":[{"id":"x');
    }
    const rec = recover({ walPath: this.walPath, chkPath: this.chkPath, pattern: this.pattern });
    this.monitor = rec.monitor;
    this.seq = rec.seq;
    this.hash = rec.hash;
    this.wal = new WalWriter(this.walPath);
    return {
      seq: this.seq,
      state: this.monitor.verdict(),
      ambiguous: this.monitor.ambiguousEver,
      hash: this.hash,
      replayed: rec.replayed,
    };
  }

  status() {
    return {
      seq: this.seq,
      state: this.monitor.verdict(),
      ambiguous: this.monitor.ambiguousEver,
      hash: this.hash,
    };
  }

  close() {
    this.wal.close();
  }
}

module.exports = { Engine, genesisHash, Monitor };
