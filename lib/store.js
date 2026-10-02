// Offline certificate segment store.
//
// Layout inside the store directory:
//   segments/<id>.json   committed (and possibly orphan/torn) segments
//   quarantine/<id>.json torn or uncommitted segments moved by recover
//   manifest.json        hash-chained manifest (written via tmp + rename)
//   manifest.json.tmp    leftover from an interrupted manifest replace
//
// Trust model: no keys, no network. The manifest head is a hash chain over
// epoch + every segment hash + every tombstone; any single-byte tamper is
// detected as E_CHAIN before any operation mutates state.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokenize } from './text.js';
import { buildIndex, decodeIndex, phraseMatch } from './postings.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function paths(dir) {
  return {
    segments: path.join(dir, 'segments'),
    quarantine: path.join(dir, 'quarantine'),
    manifest: path.join(dir, 'manifest.json'),
    manifestTmp: path.join(dir, 'manifest.json.tmp'),
  };
}

function ensureLayout(dir) {
  fs.mkdirSync(paths(dir).segments, { recursive: true });
  fs.mkdirSync(paths(dir).quarantine, { recursive: true });
}

function segmentPath(dir, id) {
  return path.join(paths(dir).segments, id + '.json');
}

export function segmentHash(seg) {
  return 'sha256:' + sha256hex(canonical({
    id: seg.id, epoch: seg.epoch, text: seg.text, index: seg.index,
  }));
}

// Tombstones chain into the head without their (recursive) `before` payload.
function slimTombstone(t) {
  return { id: t.id, segHash: t.segHash, pred: t.pred, succ: t.succ, epoch: t.epoch };
}

export function computeHead(m) {
  let h = sha256hex('cert-store/v1');
  h = sha256hex(h + '\nepoch:' + m.epoch);
  for (const s of m.segments) h = sha256hex(h + '\nseg:' + s.id + ':' + s.hash);
  for (const t of m.tombstones) h = sha256hex(h + '\ntomb:' + canonical(slimTombstone(t)));
  return 'sha256:' + h;
}

function emptyManifest() {
  const m = { version: 1, epoch: 0, segments: [], tombstones: [] };
  m.head = computeHead(m);
  return m;
}

function loadManifest(dir) {
  const p = paths(dir).manifest;
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new StoreError('E_CHAIN', 'manifest.json is unreadable');
  }
}

function readSegment(dir, id) {
  let raw;
  try {
    raw = fs.readFileSync(segmentPath(dir, id), 'utf8');
  } catch {
    return { ok: false, reason: 'missing' };
  }
  try {
    return { ok: true, seg: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
}

// Verify the full chain. Throws E_CHAIN on any inconsistency.
export function verifyStore(dir) {
  const m = loadManifest(dir) ?? emptyManifest();
  for (const entry of m.segments) {
    const r = readSegment(dir, entry.id);
    if (!r.ok) throw new StoreError('E_CHAIN', `segment ${entry.id} ${r.reason}`);
    const hash = segmentHash(r.seg);
    if (hash !== entry.hash || r.seg.hash !== entry.hash) {
      throw new StoreError('E_CHAIN', `segment ${entry.id} hash mismatch`);
    }
  }
  if (computeHead(m) !== m.head) {
    throw new StoreError('E_CHAIN', 'manifest head mismatch');
  }
  return m;
}

// Crash-safe write: tmp file + fsync + atomic rename + dir fsync.
function writeFileAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  const dfd = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(dfd);
  } finally {
    fs.closeSync(dfd);
  }
}

function writeManifest(dir, m) {
  m.head = computeHead(m);
  writeFileAtomic(paths(dir).manifest, JSON.stringify(m, null, 2) + '\n');
}

export function buildSegment(id, epoch, text) {
  const seg = { id, epoch, text, index: buildIndex(tokenize(text)) };
  seg.hash = segmentHash(seg);
  return seg;
}

export function writeSegmentFile(dir, seg) {
  ensureLayout(dir);
  writeFileAtomic(segmentPath(dir, seg.id), JSON.stringify(seg, null, 2) + '\n');
}

function checkId(id) {
  if (!ID_RE.test(id || '')) {
    throw new StoreError('E_ABSENT', `invalid segment id: ${id}`);
  }
}

function isOrphan(dir, id) {
  return fs.existsSync(segmentPath(dir, id))
    || fs.existsSync(path.join(paths(dir).quarantine, id + '.json'));
}

export function put(dir, id, text) {
  checkId(id);
  ensureLayout(dir);
  const m = verifyStore(dir);
  const epoch = m.epoch + 1;
  const seg = buildSegment(id, epoch, text);
  writeSegmentFile(dir, seg);
  const entry = { id, hash: seg.hash };
  const i = m.segments.findIndex((s) => s.id === id);
  if (i >= 0) m.segments[i] = entry;
  else m.segments.push(entry);
  m.epoch = epoch;
  writeManifest(dir, m);
  return { id, hash: seg.hash, epoch };
}

export function del(dir, id) {
  checkId(id);
  ensureLayout(dir);
  const m = verifyStore(dir);
  const i = m.segments.findIndex((s) => s.id === id);
  if (i < 0) {
    if (isOrphan(dir, id)) {
      throw new StoreError('E_TORN', `segment ${id} is not committed to the chain`);
    }
    throw new StoreError('E_ABSENT', `segment ${id} not found`);
  }
  const before = {
    epoch: m.epoch,
    segments: m.segments.map((s) => ({ ...s })),
    tombstones: m.tombstones.map(slimTombstone),
  };
  before.head = computeHead(before);
  const tombstone = {
    id,
    segHash: m.segments[i].hash,
    pred: i > 0 ? m.segments[i - 1].id : null,
    succ: i < m.segments.length - 1 ? m.segments[i + 1].id : null,
    epoch: m.epoch + 1,
    before,
  };
  m.segments.splice(i, 1);
  m.tombstones.push(tombstone);
  m.epoch += 1;
  writeManifest(dir, m); // commit exclusion first, then drop the data
  fs.rmSync(segmentPath(dir, id), { force: true });
  return { id, epoch: m.epoch };
}

export function query(dir, phrase) {
  const m = verifyStore(dir);
  const phraseTokens = tokenize(phrase);
  if (phraseTokens.length === 0) return [];
  const hits = [];
  for (const entry of m.segments) {
    const r = readSegment(dir, entry.id);
    if (!r.ok) throw new StoreError('E_CHAIN', `segment ${entry.id} ${r.reason}`);
    if (phraseMatch(decodeIndex(r.seg.index), phraseTokens)) hits.push(entry.id);
  }
  return hits;
}

export function prove(dir, id) {
  checkId(id);
  const m = verifyStore(dir);
  const state = {
    epoch: m.epoch, segments: m.segments, tombstones: m.tombstones, head: m.head,
  };
  const entry = m.segments.find((s) => s.id === id);
  if (entry) {
    const r = readSegment(dir, id);
    return {
      type: 'inclusion',
      id,
      hash: entry.hash,
      segment: { id: r.seg.id, epoch: r.seg.epoch, text: r.seg.text, index: r.seg.index },
      state,
    };
  }
  const tomb = m.tombstones.find((t) => t.id === id);
  if (tomb) {
    return {
      type: 'exclusion',
      id,
      tombstone: tomb,
      state,
      priorInclusion: { id, hash: tomb.segHash, before: tomb.before },
    };
  }
  if (isOrphan(dir, id)) {
    throw new StoreError('E_TORN', `segment ${id} is not committed to the chain`);
  }
  throw new StoreError('E_ABSENT', `segment ${id} not found`);
}

// Recover to the last complete chain. Torn/uncommitted segments are moved
// to quarantine and never counted by queries. On E_CHAIN nothing changes.
export function recover(dir) {
  ensureLayout(dir);
  const p = paths(dir);
  const m = verifyStore(dir); // throws E_CHAIN before any mutation
  const log = [];
  if (fs.existsSync(p.manifestTmp)) {
    fs.rmSync(p.manifestTmp);
    log.push('RECOVER discard manifest.json.tmp');
  }
  const known = new Set(m.segments.map((s) => s.id));
  for (const name of fs.readdirSync(p.segments).sort()) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
    if (name === id + '.json' && known.has(id)) continue;
    let reason = 'uncommitted';
    try {
      JSON.parse(fs.readFileSync(path.join(p.segments, name), 'utf8'));
    } catch {
      reason = 'torn-write';
    }
    fs.renameSync(path.join(p.segments, name), path.join(p.quarantine, name));
    log.push(`RECOVER quarantine ${name} reason=${reason}`);
  }
  log.push(`RECOVER ok epoch=${m.epoch} head=${m.head}`);
  return log;
}
