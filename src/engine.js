'use strict';

const fs = require('fs');
const { SafetyMonitor, MonitorError, stateHash } = require('./monitor');
const { Wal, writeCheckpoint, readCheckpoint } = require('./store');

// Recover the deterministic monitor state after a crash:
// load the newest consistent checkpoint, then replay WAL records on top,
// verifying sequence contiguity and per-record state hashes.
function recover(pattern, walPath, ckptPath) {
  const mon = new SafetyMonitor(pattern);
  const ckpt = readCheckpoint(ckptPath);
  if (ckpt !== null) {
    const expect = stateHash(ckpt.seq, ckpt.state.dfaKey, ckpt.state.violation, ckpt.state.ambiguous);
    if (ckpt.hash !== expect) throw new MonitorError(`checkpoint hash mismatch at seq ${ckpt.seq}`);
    mon.restore(ckpt.state);
  }
  const records = new Wal(walPath).readAll();
  let expectedSeq = 1;
  for (const rec of records) {
    if (typeof rec.seq !== 'number' || rec.seq !== expectedSeq) {
      throw new MonitorError(`sequence gap in WAL: expected seq ${expectedSeq}, got ${rec.seq}`);
    }
    expectedSeq++;
    if (rec.seq <= mon.seq) continue; // already covered by the checkpoint
    mon.applyBatch(rec.events);
    if (mon.hash() !== rec.hash) {
      throw new MonitorError(`state hash mismatch at seq ${rec.seq}`);
    }
  }
  return mon;
}

// Process a JSONL script of records:
//   {"type":"init","pattern":"..."}   (must be first)
//   {"type":"batch","events":[{"id":...,"name":"..."},...], "seq":?}
//   {"type":"checkpoint"}
//   {"type":"crash"}                  (discard memory, recover from disk)
//   {"type":"status"}                 (emit a status line via out())
function runScript(records, { walPath, ckptPath, out }) {
  const wal = new Wal(walPath);
  wal.reset();
  fs.rmSync(ckptPath, { force: true });
  fs.rmSync(ckptPath + '.tmp', { force: true });

  let mon = null;
  let pattern = null;

  for (const rec of records) {
    if (rec === null || typeof rec !== 'object') throw new MonitorError('record must be an object');
    switch (rec.type) {
      case 'init':
        if (mon !== null) throw new MonitorError('duplicate init record');
        if (typeof rec.pattern !== 'string') throw new MonitorError('init.pattern must be a string');
        pattern = rec.pattern;
        mon = new SafetyMonitor(pattern);
        break;
      case 'batch': {
        if (mon === null) throw new MonitorError('batch before init');
        if (rec.seq !== undefined && rec.seq !== mon.seq + 1) {
          throw new MonitorError(`sequence gap: expected seq ${mon.seq + 1}, got ${rec.seq}`);
        }
        const r = mon.applyBatch(rec.events);
        wal.append({ seq: r.seq, events: rec.events, hash: r.hash });
        break;
      }
      case 'checkpoint': {
        if (mon === null) throw new MonitorError('checkpoint before init');
        writeCheckpoint(ckptPath, { seq: mon.seq, hash: mon.hash(), state: mon.snapshot() });
        break;
      }
      case 'crash': {
        if (mon === null) throw new MonitorError('crash before init');
        mon = recover(pattern, walPath, ckptPath);
        break;
      }
      case 'status': {
        if (mon === null) throw new MonitorError('status before init');
        out(mon.status());
        break;
      }
      default:
        throw new MonitorError(`unknown record type: ${JSON.stringify(rec.type)}`);
    }
  }
  return mon;
}

module.exports = { runScript, recover };
