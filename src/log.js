// Segmented command log with batch-atomic commits and crash recovery.
//
// On-disk layout inside the log directory:
//   seg-<n>.log   one segment (batch) per file:
//                   @SEG <n>
//                   R <json event>          (one per record)
//                   @COMMIT <n> <count> <crc16>
//   manifest.log  append-only, one "@MANIFEST <n>" line per committed batch
//
// commit() write order defines the two fault points:
//   1. data records written, @COMMIT not written  -> recovery DISCARDS the batch
//   2. @COMMIT written, manifest not written      -> recovery keeps the batch VISIBLE
// A partial record never takes effect: visibility is decided per batch.
//
// Recovery rules:
//   - segment with valid @COMMIT (count + crc match): visible, manifest or not
//   - segment without valid @COMMIT:
//       listed in manifest  -> ERR_CORRUPT (committed batch was damaged)
//       not in manifest   -> uncommitted tail, discarded silently
//   - first corrupt segment stops the scan (later causal chain untrusted)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ERR_CORRUPT = 'ERR_CORRUPT';

const SEG_FILE_RE = /^seg-(\d+)\.log$/;

function crc16(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function encodeRecords(events) {
  return events.map((e) => `R ${JSON.stringify(e)}`).join('\n') + '\n';
}

function parseSegment(text, id) {
  const lines = text.split('\n');
  if (!text.endsWith('\n')) lines.pop(); // torn final line: drop it
  else lines.pop(); // trailing empty string after final newline
  if (lines.length === 0 || lines[0] !== `@SEG ${id}`) {
    return { ok: false, reason: 'missing or mismatched @SEG header' };
  }
  const events = [];
  let commit = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('R ')) {
      try {
        events.push(JSON.parse(line.slice(2)));
      } catch {
        return { ok: false, reason: `unparseable record at line ${i + 1}` };
      }
    } else if (line.startsWith('@COMMIT ')) {
      const m = /^@COMMIT (\d+) (\d+) ([0-9a-f]{16})$/.exec(line);
      if (!m) return { ok: false, reason: 'malformed @COMMIT line' };
      commit = { id: Number(m[1]), count: Number(m[2]), crc: m[3] };
    } else {
      return { ok: false, reason: `unknown line ${i + 1}: ${JSON.stringify(line)}` };
    }
  }
  if (!commit) return { ok: false, reason: 'missing @COMMIT' };
  if (commit.id !== id) return { ok: false, reason: 'commit id mismatch' };
  if (commit.count !== events.length) {
    return { ok: false, reason: `record count mismatch: commit says ${commit.count}, found ${events.length}` };
  }
  if (crc16(encodeRecords(events)) !== commit.crc) {
    return { ok: false, reason: 'crc mismatch' };
  }
  return { ok: true, events };
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.log');
  const ids = new Set();
  if (!fs.existsSync(file)) return ids;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const m = /^@MANIFEST (\d+)$/.exec(line);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

export class CommandLog {
  #dir;
  #pending;
  #next;

  constructor(dir, nextSegment) {
    this.#dir = dir;
    this.#pending = [];
    this.#next = nextSegment;
  }

  static open(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return new CommandLog(dir, 0);
  }

  get dir() {
    return this.#dir;
  }

  get pendingCount() {
    return this.#pending.length;
  }

  append(name) {
    this.#pending.push({ type: 'cmd', name });
  }

  ack(sensor, value) {
    this.#pending.push({ type: 'ack', sensor, value });
  }

  // Flush the pending batch as one segment. Returns the segment id, or null
  // when there is nothing to commit.
  commit() {
    if (this.#pending.length === 0) return null;
    const id = this.#next;
    const file = path.join(this.#dir, `seg-${id}.log`);
    const data = encodeRecords(this.#pending);
    // Fault point 1: a crash here leaves data without @COMMIT -> batch discarded.
    fs.writeFileSync(file, `@SEG ${id}\n${data}`);
    // Fault point 2: a crash here leaves @COMMIT without manifest -> batch visible.
    fs.appendFileSync(file, `@COMMIT ${id} ${this.#pending.length} ${crc16(data)}\n`);
    fs.appendFileSync(path.join(this.#dir, 'manifest.log'), `@MANIFEST ${id}\n`);
    this.#pending = [];
    this.#next = id + 1;
    return id;
  }

  // Recover a log directory after a crash. Never throws on corrupt content;
  // reports bad segments with ERR_CORRUPT instead.
  static recover(dir) {
    const manifested = readManifest(dir);
    const segIds = fs
      .readdirSync(dir)
      .map((f) => SEG_FILE_RE.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);

    const events = [];
    const corrupt = [];
    const discarded = [];
    let next = 0;

    for (const id of segIds) {
      const text = fs.readFileSync(path.join(dir, `seg-${id}.log`), 'utf8');
      const parsed = parseSegment(text, id);
      if (parsed.ok) {
        events.push(...parsed.events);
        next = id + 1;
      } else if (manifested.has(id)) {
        corrupt.push({ segment: id, error: ERR_CORRUPT, reason: parsed.reason });
        break; // do not trust any later segment
      } else {
        discarded.push(id); // uncommitted tail: batch never happened
      }
    }

    return {
      log: new CommandLog(dir, next),
      events,
      corrupt,
      discarded,
      manifested: [...manifested].sort((a, b) => a - b),
    };
  }
}
