import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32 } from './crc32.js';

export const MAGIC = Buffer.from('SCHK');
export const HEADER_LEN = 64;
const TAIL_GRAIN = 64 * 1024;
const ZERO_BUF = Buffer.alloc(TAIL_GRAIN);
const ZERO_HASH = Buffer.alloc(32);

export class BizError extends Error {
  constructor(message) { super(message); this.exitCode = 1; }
}
export class CorruptError extends Error {
  constructor(message) { super(message); this.exitCode = 2; }
}

function sha256(buf) { return createHash('sha256').update(buf).digest(); }

function encodeChunk(events, prevHash, offset) {
  const parts = [];
  let payloadLen = 0;
  for (const ev of events) {
    const body = Buffer.from(JSON.stringify(ev), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    parts.push(len, body);
    payloadLen += 4 + body.length;
  }
  const payload = Buffer.concat(parts);
  const end = offset + HEADER_LEN + payload.length;
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(1, 4);
  header.writeUInt8(0, 5);
  header.writeUInt16BE(HEADER_LEN, 6);
  header.writeUInt32BE(events.length, 8);
  header.writeUInt32BE(payload.length, 12);
  prevHash.copy(header, 16);
  header.writeBigUInt64BE(BigInt(end), 48);
  const crc = crc32(Buffer.concat([header.subarray(0, 56), payload]));
  header.writeUInt32BE(crc, 56);
  return Buffer.concat([header, payload]);
}

function parseEvents(payload) {
  const events = [];
  let p = 0;
  while (p < payload.length) {
    const len = payload.readUInt32BE(p);
    if (len > payload.length - p - 4) throw new Error('bad event length');
    events.push(JSON.parse(payload.subarray(p + 4, p + 4 + len).toString('utf8')));
    p += 4 + len;
  }
  return events;
}

function tailAllZero(fd, offset, size) {
  const buf = Buffer.alloc(TAIL_GRAIN);
  let pos = offset;
  while (pos < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(TAIL_GRAIN, size - pos), pos);
    if (!buf.subarray(0, n).equals(ZERO_BUF.subarray(0, n))) return false;
    pos += n;
  }
  return true;
}

export function scanFile(path) {
  if (!fs.existsSync(path)) return { size: 0, chunks: [], truncated: 0 };
  const fd = fs.openSync(path, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const chunks = [];
    let offset = 0;
    let prevHash = ZERO_HASH;
    let broken = false;
    let truncated = 0;
    while (offset < size) {
      const remaining = size - offset;
      const headLen = Math.min(HEADER_LEN, remaining);
      const head = Buffer.alloc(headLen);
      fs.readSync(fd, head, 0, headLen, offset);
      if (head.every((b) => b === 0)) {
        if (tailAllZero(fd, offset, size)) { truncated = remaining; break; }
        chunks.push({ index: chunks.length, offset, end: offset, eventCount: 0, status: 'quarantined', reason: 'corrupt-tail', events: [] });
        broken = true;
        break;
      }
      if (remaining < HEADER_LEN) { truncated = remaining; break; }
      if (!head.subarray(0, 4).equals(MAGIC)) {
        chunks.push({ index: chunks.length, offset, end: offset, eventCount: 0, status: 'quarantined', reason: 'bad-magic', events: [] });
        broken = true;
        break;
      }
      const payloadLen = head.readUInt32BE(12);
      const end = offset + HEADER_LEN + payloadLen;
      if (end > size) { truncated = remaining; break; }
      const raw = Buffer.alloc(HEADER_LEN + payloadLen);
      fs.readSync(fd, raw, 0, raw.length, offset);
      const hash = sha256(raw);
      const crcOk = crc32(Buffer.concat([raw.subarray(0, 56), raw.subarray(HEADER_LEN)])) === head.readUInt32BE(56);
      const prevOk = Buffer.from(head.subarray(16, 48)).equals(prevHash);
      const endOk = head.readBigUInt64BE(48) === BigInt(end);
      let status;
      if (!broken && crcOk && prevOk && endOk) status = 'confirmed';
      else if (!broken) { status = 'quarantined'; broken = true; }
      else status = 'pending';
      const chunk = { index: chunks.length, offset, end, eventCount: head.readUInt32BE(8), hash: hash.toString('hex'), status, events: [] };
      if (status === 'quarantined') chunk.reason = !crcOk ? 'crc-mismatch' : !prevOk ? 'prev-hash-mismatch' : 'chain-broken';
      if (status === 'pending') chunk.reason = 'chain-broken';
      try { chunk.events = parseEvents(raw.subarray(HEADER_LEN)); } catch { chunk.events = []; }
      chunks.push(chunk);
      prevHash = hash;
      offset = end;
    }
    return { size, chunks, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

function applyEvent(state, ev) {
  const bal = state.accounts[ev.account] ?? 0;
  switch (ev.type) {
    case 'deposit':
      state.accounts[ev.account] = bal + ev.amount;
      break;
    case 'refund':
      state.accounts[ev.account] = bal - ev.amount;
      break;
    case 'fee':
      state.accounts[ev.account] = bal - ev.amount;
      state.fees[ev.account] = (state.fees[ev.account] ?? 0) + ev.amount;
      break;
    case 'cancel': {
      const orig = state.txIndex[ev.ref].event;
      if (orig.type === 'deposit') state.accounts[ev.account] = bal - orig.amount;
      else if (orig.type === 'refund') state.accounts[ev.account] = bal + orig.amount;
      else if (orig.type === 'fee') {
        state.accounts[ev.account] = bal + orig.amount;
        state.fees[ev.account] -= orig.amount;
      }
      state.cancelled.add(ev.ref);
      break;
    }
    default:
      throw new BizError(`unknown event type ${ev.type}`);
  }
  state.txIndex[ev.tx] = { event: ev };
}

function validateEvent(state, ev) {
  if (!ev || typeof ev !== 'object') throw new BizError('event must be an object');
  if (!['deposit', 'refund', 'fee', 'cancel'].includes(ev.type)) throw new BizError(`unknown event type ${ev.type}`);
  if (typeof ev.account !== 'string' || !ev.account) throw new BizError('event requires account');
  if (typeof ev.tx !== 'string' || !ev.tx) throw new BizError('event requires tx');
  if (state.txIndex[ev.tx]) throw new BizError(`duplicate tx ${ev.tx}`);
  if (ev.type === 'cancel') {
    if (typeof ev.ref !== 'string' || !ev.ref) throw new BizError('cancel requires ref');
    const orig = state.txIndex[ev.ref];
    if (!orig) throw new BizError(`cancel references unknown tx ${ev.ref}`);
    if (orig.event.type === 'cancel') throw new BizError('cannot cancel a cancel event');
    if (state.cancelled.has(ev.ref)) throw new BizError(`tx ${ev.ref} already cancelled`);
    ev.account = orig.event.account;
    ev.amount = orig.event.amount;
  } else if (!Number.isInteger(ev.amount) || ev.amount <= 0) {
    throw new BizError('amount must be a positive integer');
  }
  applyEvent(state, ev);
  if (state.accounts[ev.account] < 0) throw new BizError(`${ev.type} would make account ${ev.account} balance negative`);
}

function buildState(chunks) {
  const state = { accounts: {}, fees: {}, txIndex: {}, cancelled: new Set() };
  for (const c of chunks) {
    if (c.status !== 'confirmed') continue;
    for (const ev of c.events) applyEvent(state, ev);
  }
  return state;
}

export function stateView(state) {
  const total = Object.values(state.fees).reduce((a, b) => a + b, 0);
  return { accounts: state.accounts, fees: { byAccount: state.fees, total } };
}

export function appendEvents(path, events) {
  if (!events.length) throw new BizError('no events to append');
  let scan = scanFile(path);
  if (scan.chunks.some((c) => c.status !== 'confirmed')) {
    throw new CorruptError('chain broken: quarantined or pending chunks present');
    }
  if (scan.truncated > 0) {
    fs.truncateSync(path, scan.size - scan.truncated);
    scan = scanFile(path);
  }
  const state = buildState(scan.chunks);
  for (const ev of events) validateEvent(state, ev);
  const prevHash = scan.chunks.length ? Buffer.from(scan.chunks[scan.chunks.length - 1].hash, 'hex') : ZERO_HASH;
  const offset = scan.chunks.length ? scan.chunks[scan.chunks.length - 1].end : 0;
  const chunk = encodeChunk(events, prevHash, offset);
  fs.appendFileSync(path, chunk);
  writeIndex(path);
  return { index: scan.chunks.length, offset, end: offset + chunk.length, events: events.length };
}

export function stateOfFile(path) {
  const scan = scanFile(path);
  if (scan.chunks.some((c) => c.status !== 'confirmed')) {
    throw new CorruptError('chain broken: quarantined or pending chunks present');
  }
  return buildState(scan.chunks);
}

const indexPath = (path) => `${path}.index.json`;
const manifestPath = (path) => `${path}.quarantine.json`;

export function writeIndex(path) {
  const scan = scanFile(path);
  const index = { version: 1, fileSize: scan.chunks.length ? scan.chunks[scan.chunks.length - 1].end : 0, chunks: [], tx: {}, account: {} };
  for (const c of scan.chunks) {
    index.chunks.push({ index: c.index, offset: c.offset, end: c.end, eventCount: c.eventCount, hash: c.hash, status: c.status });
    if (c.status !== 'confirmed') continue;
    for (const ev of c.events) {
      index.tx[ev.tx] = c.index;
      if (!index.account[ev.account]) index.account[ev.account] = [];
      if (!index.account[ev.account].includes(c.index)) index.account[ev.account].push(c.index);
    }
  }
  fs.writeFileSync(indexPath(path), JSON.stringify(index, null, 2));
  return index;
}

function loadIndex(path) {
  if (!fs.existsSync(indexPath(path))) throw new BizError('index missing; run rebuild');
  const index = JSON.parse(fs.readFileSync(indexPath(path), 'utf8'));
  if (index.fileSize !== fs.statSync(path).size) throw new BizError('index stale; run rebuild');
  return index;
}

export function findEvents(path, { tx, account }) {
  const index = loadIndex(path);
  let chunkIndices;
  if (tx != null) {
    const i = index.tx[tx];
    chunkIndices = i == null ? [] : [i];
  } else {
    chunkIndices = index.account[account] ?? [];
  }
  const fd = fs.openSync(path, 'r');
  try {
    const matches = [];
    for (const ci of chunkIndices) {
      const meta = index.chunks[ci];
      if (meta.status !== 'confirmed') throw new CorruptError(`chunk ${ci} is ${meta.status}`);
      const raw = Buffer.alloc(meta.end - meta.offset);
      fs.readSync(fd, raw, 0, raw.length, meta.offset);
      if (!raw.subarray(0, 4).equals(MAGIC)) throw new CorruptError(`chunk ${ci} has bad magic`);
      const crcOk = crc32(Buffer.concat([raw.subarray(0, 56), raw.subarray(HEADER_LEN)])) === raw.readUInt32BE(56);
      if (!crcOk) throw new CorruptError(`chunk ${ci} failed CRC check`);
      const events = parseEvents(raw.subarray(HEADER_LEN));
      events.forEach((ev, k) => {
        if ((tx != null && ev.tx === tx) || (account != null && ev.account === account)) {
          matches.push({ chunk: ci, offset: meta.offset, eventIndex: k, event: ev });
        }
      });
    }
    return matches;
  } finally {
    fs.closeSync(fd);
  }
}

function chunkBrief(c) {
  const out = { index: c.index, offset: c.offset, end: c.end, events: c.eventCount };
  if (c.reason) out.reason = c.reason;
  return out;
}

export function verify(path) {
  const scan = scanFile(path);
  const state = buildState(scan.chunks);
  const quarantined = scan.chunks.filter((c) => c.status === 'quarantined').map(chunkBrief);
  const pending = scan.chunks.filter((c) => c.status === 'pending').map(chunkBrief);
  const manifest = { quarantined, pending, quarantinePoint: quarantined.length ? quarantined[0].index : null };
  fs.writeFileSync(manifestPath(path), JSON.stringify(manifest, null, 2));
  return { scan, state, quarantined, pending };
}

export function rebuild(path) {
  let scan = scanFile(path);
  let truncated = 0;
  if (scan.truncated > 0) {
    truncated = 1;
    fs.truncateSync(path, scan.size - scan.truncated);
    scan = scanFile(path);
  }
  writeIndex(path);
  const { quarantined, pending } = verify(path);
  return { truncated, chunks: scan.chunks.filter((c) => c.status === 'confirmed').length, quarantined, pending };
}
