import fs from 'node:fs';
import { deepStrictEqual } from 'node:assert';
import { AuditError } from './errors.js';
import { encodeBlock, readBlockAt, KIND, ZERO_HASH } from './format.js';
import { loadManifest, saveManifest, manifestPath } from './manifest.js';

export const DEFAULT_WINDOW = 8;

export function emptyState() {
  return { seq: 0, accounts: {}, payments: {} };
}

// Apply one event at the given sequence number, validating business rules.
export function applyEvent(state, event, seq) {
  const range = [seq, seq];
  switch (event.type) {
    case 'pay': {
      const acct = state.accounts[event.account];
      if (!acct) throw new AuditError('UNKNOWN_ACCOUNT', `unknown account: ${event.account}`, range);
      if (state.payments[event.id]) throw new AuditError('DUPLICATE_PAYMENT', `duplicate payment: ${event.id}`, range);
      const amount = event.amount;
      if (!Number.isFinite(amount) || amount <= 0) throw new AuditError('INVALID_AMOUNT', `invalid amount: ${amount}`, range);
      if (acct.limit - acct.used < amount) {
        throw new AuditError('INSUFFICIENT_FUNDS', `payment ${event.id} exceeds available credit on ${event.account}`, range);
      }
      acct.used += amount;
      state.payments[event.id] = { account: event.account, amount, cancelled: false };
      break;
    }
    case 'cancel': {
      const payment = state.payments[event.paymentId];
      if (!payment) throw new AuditError('UNKNOWN_PAYMENT', `unknown payment: ${event.paymentId}`, range);
      if (payment.cancelled) throw new AuditError('ALREADY_CANCELLED', `payment already cancelled: ${event.paymentId}`, range);
      payment.cancelled = true;
      state.accounts[payment.account].used -= payment.amount;
      break;
    }
    case 'limit': {
      const acct = (state.accounts[event.account] ??= { limit: 0, used: 0 });
      const newLimit = event.limit;
      if (!Number.isFinite(newLimit) || newLimit < 0) throw new AuditError('INVALID_LIMIT', `invalid limit: ${newLimit}`, range);
      if (newLimit - acct.used < 0) {
        throw new AuditError('NEGATIVE_AVAILABLE', `limit ${newLimit} below used ${acct.used} on ${event.account}`, range);
      }
      acct.limit = newLimit;
      break;
    }
    default:
      throw new AuditError('UNKNOWN_EVENT', `unknown event type: ${event.type}`, range);
  }
  state.seq = seq;
}

function pushBlockEntry(manifest, entry) {
  manifest.blocks.push(entry);
  while (manifest.blocks.length > manifest.window) manifest.blocks.shift();
}

export function initLedger(file, window = DEFAULT_WINDOW) {
  if (fs.existsSync(file)) throw new AuditError('LEDGER_EXISTS', `ledger already exists: ${file}`);
  const { raw, hash } = encodeBlock({ kind: KIND.ANCHOR, seqStart: 0, seqEnd: 0, prevHash: ZERO_HASH, payload: emptyState() });
  fs.writeFileSync(file, raw);
  const entry = { kind: 'anchor', seqStart: 0, seqEnd: 0, offset: 0, length: raw.length, hash: hash.toString('hex') };
  const manifest = { version: 1, window, nextSeq: 1, anchor: entry, blocks: [entry] };
  saveManifest(manifestPath(file), manifest);
  return manifest;
}

function ensureLedger(file) {
  if (!fs.existsSync(file)) initLedger(file);
}

// Decode state by starting at the latest anchor recorded in the manifest and
// walking the forward block chain to EOF. Never reads blocks before the anchor.
function decodeFromAnchor(fd, fileSize, manifest, collectFrom = null) {
  const anchorBlock = readBlockAt(fd, manifest.anchor.offset, fileSize);
  if (anchorBlock.kind !== KIND.ANCHOR) {
    throw new AuditError('ANCHOR_KIND_MISMATCH', `block at anchor offset ${manifest.anchor.offset} is not an anchor`, [anchorBlock.seqStart, anchorBlock.seqEnd]);
  }
  if (anchorBlock.hash.toString('hex') !== manifest.anchor.hash) {
    throw new AuditError('ANCHOR_HASH_MISMATCH', `anchor block hash mismatch at offset ${manifest.anchor.offset}`, [anchorBlock.seqStart, anchorBlock.seqEnd]);
  }
  const state = anchorBlock.payload;
  let lastHash = anchorBlock.hash;
  let offset = manifest.anchor.offset + anchorBlock.length;
  const events = [];
  while (offset < fileSize) {
    const block = readBlockAt(fd, offset, fileSize);
    if (!block.prevHash.equals(lastHash)) {
      throw new AuditError('CHAIN_BROKEN', `prev hash mismatch at block seq ${block.seqStart}-${block.seqEnd}`, [block.seqStart, block.seqEnd]);
    }
    if (block.kind === KIND.ANCHOR) {
      state.seq = block.payload.seq;
      state.accounts = block.payload.accounts;
      state.payments = block.payload.payments;
    } else {
      let seq = block.seqStart;
      for (const event of block.payload.events) {
        applyEvent(state, event, seq);
        if (collectFrom !== null && seq >= collectFrom) events.push({ seq, ...event });
        seq++;
      }
    }
    lastHash = block.hash;
    offset += block.length;
  }
  return { state, lastHash, events };
}

export function appendEvents(file, events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new AuditError('NO_EVENTS', 'append requires at least one event');
  }
  ensureLedger(file);
  const mftPath = manifestPath(file);
  const manifest = loadManifest(mftPath);
  const fd = fs.openSync(file, 'r+');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const { state, lastHash } = decodeFromAnchor(fd, fileSize, manifest);
    const seqStart = state.seq + 1;
    events.forEach((event, i) => applyEvent(state, event, seqStart + i));
    const seqEnd = seqStart + events.length - 1;
    const { raw, hash } = encodeBlock({ kind: KIND.DELTA, seqStart, seqEnd, prevHash: lastHash, payload: { events } });
    fs.writeSync(fd, raw, 0, raw.length, fileSize);
    fs.fsyncSync(fd);
    pushBlockEntry(manifest, { kind: 'delta', seqStart, seqEnd, offset: fileSize, length: raw.length, hash: hash.toString('hex') });
    manifest.nextSeq = seqEnd + 1;
    saveManifest(mftPath, manifest);
    return { seqStart, seqEnd };
  } finally {
    fs.closeSync(fd);
  }
}

export function snapshot(file) {
  ensureLedger(file);
  const mftPath = manifestPath(file);
  const manifest = loadManifest(mftPath);
  const fd = fs.openSync(file, 'r+');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const { state, lastHash } = decodeFromAnchor(fd, fileSize, manifest);
    const { raw, hash } = encodeBlock({ kind: KIND.ANCHOR, seqStart: 0, seqEnd: state.seq, prevHash: lastHash, payload: state });
    fs.writeSync(fd, raw, 0, raw.length, fileSize);
    fs.fsyncSync(fd);
    const entry = { kind: 'anchor', seqStart: 0, seqEnd: state.seq, offset: fileSize, length: raw.length, hash: hash.toString('hex') };
    manifest.anchor = entry;
    pushBlockEntry(manifest, entry);
    saveManifest(mftPath, manifest);
    return { seq: state.seq, offset: fileSize, hash: entry.hash };
  } finally {
    fs.closeSync(fd);
  }
}

export function readState(file) {
  const manifest = loadManifest(manifestPath(file));
  const fd = fs.openSync(file, 'r');
  try {
    return decodeFromAnchor(fd, fs.fstatSync(fd).size, manifest).state;
  } finally {
    fs.closeSync(fd);
  }
}

// Locate the last n events. Uses the tail manifest index when it covers the
// requested range; otherwise walks the forward chain from the latest anchor
// (never reading earlier snapshots).
export function readTail(file, n) {
  const manifest = loadManifest(manifestPath(file));
  const fd = fs.openSync(file, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const lastSeq = manifest.nextSeq - 1;
    const fromSeq = Math.max(manifest.anchor.seqEnd + 1, lastSeq - n + 1);
    if (n < 1 || fromSeq > lastSeq) {
      return { events: [], fromSeq: lastSeq + 1, toSeq: lastSeq, source: 'empty' };
    }
    const idx = manifest.blocks.findIndex((b) => b.seqEnd >= fromSeq);
    const covered = idx !== -1 && manifest.blocks[idx].seqStart <= fromSeq;
    if (covered) {
      const events = [];
      let prevHashHex = idx > 0 ? manifest.blocks[idx - 1].hash : null;
      for (let i = idx; i < manifest.blocks.length; i++) {
        const entry = manifest.blocks[i];
        const block = readBlockAt(fd, entry.offset, fileSize);
        if (block.hash.toString('hex') !== entry.hash) {
          throw new AuditError('BLOCK_HASH_MISMATCH', `block hash mismatch at offset ${entry.offset}`, [block.seqStart, block.seqEnd]);
        }
        if (prevHashHex !== null && block.prevHash.toString('hex') !== prevHashHex) {
          throw new AuditError('CHAIN_BROKEN', `prev hash mismatch at block seq ${block.seqStart}-${block.seqEnd}`, [block.seqStart, block.seqEnd]);
        }
        prevHashHex = entry.hash;
        if (block.kind === KIND.DELTA) {
          let seq = block.seqStart;
          for (const event of block.payload.events) {
            if (seq >= fromSeq) events.push({ seq, ...event });
            seq++;
          }
        }
      }
      return { events, fromSeq, toSeq: lastSeq, source: 'manifest' };
    }
    const { events } = decodeFromAnchor(fd, fileSize, manifest, fromSeq);
    return { events, fromSeq, toSeq: lastSeq, source: 'anchor-chain' };
  } finally {
    fs.closeSync(fd);
  }
}

// Full structural + business-rule verification from offset 0. With `to`,
// verifies only the prefix covering sequence numbers up to `to`.
export function verify(file, to = null) {
  const fd = fs.openSync(file, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    let offset = 0;
    let lastHash = ZERO_HASH;
    let state = null;
    let blocks = 0;
    let events = 0;
    while (offset < fileSize) {
      const block = readBlockAt(fd, offset, fileSize);
      const range = [block.seqStart, block.seqEnd];
      if (to !== null && block.kind === KIND.DELTA && block.seqStart > to) break;
      if (!block.prevHash.equals(lastHash)) {
        throw new AuditError('CHAIN_BROKEN', `prev hash mismatch at block seq ${block.seqStart}-${block.seqEnd}`, range);
      }
      if (block.kind === KIND.ANCHOR) {
        if (state !== null) {
          try {
            deepStrictEqual(block.payload, state);
          } catch {
            throw new AuditError('ANCHOR_STATE_MISMATCH', `anchor snapshot does not match replayed state at seq ${block.seqEnd}`, range);
          }
        }
        state = { seq: block.payload.seq, accounts: block.payload.accounts, payments: block.payload.payments };
      } else {
        if (state === null) throw new AuditError('ORPHAN_DELTA', 'delta block before any anchor', range);
        if (block.seqStart !== state.seq + 1) {
          throw new AuditError('SEQ_GAP', `expected seq ${state.seq + 1}, got ${block.seqStart}`, range);
        }
        let seq = block.seqStart;
        for (const event of block.payload.events) {
          applyEvent(state, event, seq);
          seq++;
          events++;
        }
        if (block.seqEnd !== state.seq) {
          throw new AuditError('SEQ_GAP', `block header seqEnd ${block.seqEnd} != applied seq ${state.seq}`, range);
        }
      }
      lastHash = block.hash;
      offset += block.length;
      blocks++;
      if (to !== null && state.seq >= to) break;
    }
    if (state === null) throw new AuditError('NO_ANCHOR', 'no anchor block found');
    return { blocks, events, lastSeq: state.seq };
  } finally {
    fs.closeSync(fd);
  }
}

export function anchorInfo(file) {
  const manifest = loadManifest(manifestPath(file));
  const fd = fs.openSync(file, 'r');
  try {
    const block = readBlockAt(fd, manifest.anchor.offset, fs.fstatSync(fd).size);
    if (block.hash.toString('hex') !== manifest.anchor.hash) {
      throw new AuditError('ANCHOR_HASH_MISMATCH', `anchor block hash mismatch at offset ${manifest.anchor.offset}`, [block.seqStart, block.seqEnd]);
    }
    return { seq: block.seqEnd, hash: manifest.anchor.hash, offset: manifest.anchor.offset };
  } finally {
    fs.closeSync(fd);
  }
}

export function cancelPayment(file, paymentId) {
  return appendEvents(file, [{ type: 'cancel', paymentId }]);
}
