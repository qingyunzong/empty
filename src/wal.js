'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { Monitor } = require('./monitor');
const { MonitorError } = require('./errors');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function genesisHash(pattern) {
  return sha256(stableStringify({ kind: 'genesis', pattern }));
}

function canonicalEvents(events) {
  return events.map((e) => ({ id: String(e.id), type: String(e.type) }));
}

// Hash chain: every WAL record commits to its sequence number, the previous
// hash, the tie-break-ordered event batch and the resulting monitor state.
function chainHash(prevHash, seq, orderedEvents, monitorSnapshot) {
  return sha256(stableStringify({
    kind: 'batch',
    seq,
    prev: prevHash,
    events: canonicalEvents(orderedEvents),
    state: monitorSnapshot,
  }));
}

class WalWriter {
  constructor(walPath) {
    this.path = walPath;
    this.fd = fs.openSync(walPath, 'a');
  }

  append(record) {
    fs.writeSync(this.fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(this.fd);
  }

  close() {
    fs.closeSync(this.fd);
  }
}

function writeCheckpoint(chkPath, checkpoint) {
  const tmp = `${chkPath}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, JSON.stringify(checkpoint));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, chkPath); // atomic publish
}

// Recover the deterministic monitor state from the checkpoint (if any) and
// the WAL. The whole chain is re-validated on every recovery:
//   - sequence numbers must be gap-free starting at 1
//   - every record hash must match recomputation
//   - the checkpoint must agree with the replayed state at its sequence
// A torn final record (crash between WAL write and fsync completion) is
// truncated; anything else malformed aborts with exit code 12.
function recover({ walPath, chkPath, pattern }) {
  let checkpoint = null;
  if (fs.existsSync(chkPath)) {
    try {
      checkpoint = JSON.parse(fs.readFileSync(chkPath, 'utf8'));
    } catch {
      throw new MonitorError('CHK_CORRUPT', `checkpoint ${chkPath} is not valid JSON`);
    }
    if (checkpoint.pattern !== pattern) {
      throw new MonitorError('PATTERN_MISMATCH', 'checkpoint pattern does not match the monitor pattern');
    }
  }

  const monitor = new Monitor(pattern);
  let seq = 0;
  let hash = genesisHash(pattern);
  let replayed = 0;

  if (fs.existsSync(walPath)) {
    const buf = fs.readFileSync(walPath);
    let offset = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset);
      const end = nl === -1 ? buf.length : nl;
      const line = buf.subarray(offset, end).toString('utf8');
      const nextOffset = nl === -1 ? buf.length : nl + 1;
      if (line.trim() === '') {
        offset = nextOffset;
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        if (nextOffset >= buf.length) {
          // Unparseable final line: torn tail from a crash mid-write.
          // Truncate the WAL back to the last complete record.
          fs.truncateSync(walPath, offset);
          break;
        }
        throw new MonitorError('WAL_CORRUPT', `corrupt WAL record at byte offset ${offset}`);
      }
      if (typeof record.seq !== 'number' || record.seq !== seq + 1) {
        throw new MonitorError(
          'SEQ_GAP',
          `WAL sequence gap: expected seq ${seq + 1}, found ${JSON.stringify(record.seq)}`,
        );
      }
      const applied = monitor.applyBatch(record.events); // validates ids, may throw DUP_ID
      const ordered = applied.order.map((id) => record.events.find((e) => String(e.id) === String(id)));
      hash = chainHash(hash, record.seq, ordered, monitor.snapshot());
      if (hash !== record.hash) {
        throw new MonitorError('HASH_MISMATCH', `WAL hash mismatch at seq ${record.seq}`);
      }
      seq = record.seq;
      replayed++;
      if (checkpoint && seq === checkpoint.seq) {
        const snap = monitor.snapshot();
        if (checkpoint.hash !== hash ||
            JSON.stringify(checkpoint.monitor.states) !== JSON.stringify(snap.states) ||
            Boolean(checkpoint.monitor.ambiguous) !== snap.ambiguous) {
          throw new MonitorError('HASH_MISMATCH', `checkpoint does not match replayed state at seq ${seq}`);
        }
      }
      offset = nextOffset;
    }
  }

  if (checkpoint) {
    if (checkpoint.seq > seq) {
      throw new MonitorError(
        'CHK_AHEAD',
        `checkpoint seq ${checkpoint.seq} is ahead of the last complete WAL seq ${seq}`,
      );
    }
  }

  return { monitor, seq, hash, replayed };
}

module.exports = {
  stableStringify,
  sha256,
  genesisHash,
  chainHash,
  canonicalEvents,
  WalWriter,
  writeCheckpoint,
  recover,
};
