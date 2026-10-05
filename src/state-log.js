'use strict';

const fs = require('node:fs');
const { JoinError } = require('./joiner');

function corrupt(message, details) {
  return new JoinError('DURABLE_STATE_CORRUPT', message, details);
}

// Durable write-ahead log. Entry kinds:
//   "in"     - a valid input record, persisted before processing
//   "out"    - an output record emitted while processing the preceding "in"
//   "commit" - marks the preceding "in" + "out"* group as fully emitted
// Every entry carries a strictly increasing seq starting at 1.
class StateLog {
  constructor(path, seq = 0) {
    this.path = path;
    this.seq = seq;
  }

  static fresh(path) {
    fs.writeFileSync(path, '');
    return new StateLog(path);
  }

  static openExisting(path) {
    const entries = StateLog.read(path);
    return { log: new StateLog(path, entries.length), entries };
  }

  append(kind, record) {
    this.seq += 1;
    fs.appendFileSync(this.path, JSON.stringify({ seq: this.seq, kind, record }) + '\n');
  }

  static read(path) {
    let text;
    try {
      text = fs.readFileSync(path, 'utf8');
    } catch (err) {
      throw corrupt(`cannot read state log: ${err.message}`, { path });
    }
    const entries = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === '') continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw corrupt(`state log line ${index + 1} is not valid JSON`, { path, line: index + 1 });
      }
      if (
        typeof entry !== 'object' || entry === null ||
        !Number.isInteger(entry.seq) || entry.seq !== entries.length + 1 ||
        (entry.kind !== 'in' && entry.kind !== 'out' && entry.kind !== 'commit')
      ) {
        throw corrupt(`state log line ${index + 1} has invalid structure or sequence`, { path, line: index + 1 });
      }
      entries.push(entry);
    }
    return entries;
  }
}

// Replays log entries into a fresh Joiner. Entries whose results were committed
// before a crash are applied with output suppressed; the uncommitted tail (at
// most one trailing "in" without "commit") is processed and emitted via emit().
// Throws JoinError(DURABLE_STATE_CORRUPT) on any structural or content mismatch.
function replayLog(entries, log, joiner, emit) {
  let index = 0;
  while (index < entries.length) {
    const inEntry = entries[index];
    if (inEntry.kind !== 'in') {
      throw corrupt('state log entry out of order: expected "in"', { seq: inEntry.seq, kind: inEntry.kind });
    }
    let next = index + 1;
    const committedOuts = [];
    while (next < entries.length && entries[next].kind === 'out') {
      committedOuts.push(entries[next].record);
      next += 1;
    }
    const committed = next < entries.length && entries[next].kind === 'commit';
    const computed = joiner.process(inEntry.record);
    if (committed) {
      if (JSON.stringify(committedOuts) !== JSON.stringify(computed)) {
        throw corrupt('state log outputs do not match deterministic replay', { seq: inEntry.seq });
      }
      next += 1;
    } else {
      if (next !== entries.length) {
        throw corrupt('state log has an uncommitted record that is not the tail', { seq: inEntry.seq });
      }
      for (const output of computed) {
        log.append('out', output);
        emit(output);
      }
      log.append('commit');
    }
    index = next;
  }
}

module.exports = { StateLog, replayLog };
