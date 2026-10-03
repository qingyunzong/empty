'use strict';
// Append-only settlement audit log with supersedes-based corrections.
// Node.js 22 standard library only.

const fs = require('fs');
const crypto = require('crypto');

const TIME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // businessTime must be within +/-7d of logTime
const GENESIS = '0'.repeat(64);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

// Signature-style hash: HMAC-SHA256 over the canonical entry (keyed, so the
// chain cannot be recomputed without the key file).
function hashEntry(key, entry) {
  return crypto.createHmac('sha256', key)
    .update(canonical({
      seq: entry.seq,
      prevHash: entry.prevHash,
      op: entry.op,
      supersedes: entry.supersedes === undefined ? null : entry.supersedes,
      businessTime: entry.businessTime,
      logTime: entry.logTime,
    }))
    .digest('hex');
}

function getOrCreateKey(keyPath) {
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, 'utf8').trim();
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyPath, key + '\n', { mode: 0o600 });
  return key;
}

function readLog(logPath) {
  const entries = [];
  if (!fs.existsSync(logPath)) return entries;
  const buf = fs.readFileSync(logPath);
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      if (i > start) {
        const raw = buf.toString('utf8', start, i);
        let entry = null;
        try { entry = JSON.parse(raw); } catch { /* corrupt line: entry stays null */ }
        entries.push({ offset: start, length: i - start, raw, entry });
      }
      start = i + 1;
    }
  }
  return entries;
}

function validateOp(op) {
  if (!op || typeof op !== 'object') return 'op must be an object';
  if (op.type === 'credit' || op.type === 'debit') {
    if (typeof op.account !== 'string' || !op.account) return 'op.account required';
    if (typeof op.bizKey !== 'string' || !op.bizKey) return 'op.bizKey required';
    if (typeof op.amount !== 'number' || !Number.isFinite(op.amount) || op.amount <= 0) {
      return 'op.amount must be a positive number';
    }
    return null;
  }
  if (op.type === 'tombstone') {
    if (typeof op.account !== 'string' || !op.account) return 'op.account required';
    if (typeof op.bizKey !== 'string' || !op.bizKey) return 'op.bizKey required';
    return null;
  }
  return 'unknown op.type: ' + op.type;
}

// Validate one entry against the chain state. Returns null or an error string.
function validateEntry(key, entry, prevHash, prevLogTime, bySeq) {
  if (entry.prevHash !== prevHash) return 'prevHash mismatch';
  if (entry.hash !== hashEntry(key, entry)) return 'hash mismatch';
  if (prevLogTime !== null && entry.logTime < prevLogTime) return 'logTime not monotonic';
  if (Math.abs(entry.businessTime - entry.logTime) > TIME_WINDOW_MS) {
    return 'businessTime outside +/-7d window of logTime';
  }
  const opErr = validateOp(entry.op);
  if (opErr) return opErr;
  const sup = entry.supersedes === undefined ? null : entry.supersedes;
  if (entry.op.type === 'tombstone' && sup === null) return 'tombstone requires supersedes';
  if (sup !== null) {
    if (typeof sup !== 'number' || sup < 0 || sup >= entry.seq) {
      return 'supersedes must point to an existing entry';
    }
    const target = bySeq.get(sup);
    if (!target) return 'supersedes target missing';
    if (target.op.type === 'tombstone') return 'cannot supersede a tombstone';
    if (target.op.bizKey !== entry.op.bizKey) return 'bizKey mismatch with superseded entry';
  }
  return null;
}

// Full-chain verification. Never truncates the log; reports the first bad entry.
function verify(logPath, keyPath) {
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  const entries = readLog(logPath);
  const bySeq = new Map();
  let prevHash = GENESIS;
  let prevLogTime = null;
  for (let i = 0; i < entries.length; i++) {
    const { offset, entry } = entries[i];
    if (entry === null) {
      return { ok: false, index: i, offset, reason: 'unparseable entry (corrupt bytes)' };
    }
    if (entry.seq !== i) {
      return { ok: false, index: i, offset, reason: 'seq mismatch: expected ' + i + ' got ' + entry.seq };
    }
    const err = validateEntry(key, entry, prevHash, prevLogTime, bySeq);
    if (err) return { ok: false, index: i, offset, reason: err };
    bySeq.set(entry.seq, entry);
    prevHash = entry.hash;
    prevLogTime = entry.logTime;
  }
  return { ok: true, count: entries.length, tip: prevHash };
}

// Crash recovery: discard dangling index entries beyond the log end, rebuild
// the index if the log is longer. The log itself is never modified.
function recover(logPath, idxPath) {
  const logSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  let idx = [];
  if (fs.existsSync(idxPath)) {
    idx = fs.readFileSync(idxPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  }
  const valid = idx.filter((e) => e.offset + e.length <= logSize);
  const logEntries = readLog(logPath);
  if (valid.length !== idx.length || valid.length !== logEntries.length) {
    const rebuilt = logEntries.map((e) => ({
      seq: e.entry ? e.entry.seq : -1, offset: e.offset, length: e.length,
      hash: e.entry ? e.entry.hash : null,
    }));
    fs.writeFileSync(idxPath, rebuilt.map((e) => JSON.stringify(e)).join('\n') + (rebuilt.length ? '\n' : ''));
    return { recovered: true, dropped: idx.length - valid.length, rebuilt: rebuilt.length };
  }
  return { recovered: false, dropped: 0, rebuilt: valid.length };
}

// Append a batch of entries in one pass. Each item: {op, businessTime?, logTime?, supersedes?}
function appendEntries(logPath, idxPath, keyPath, items) {
  recover(logPath, idxPath);
  const key = getOrCreateKey(keyPath);
  const existing = readLog(logPath);
  const bySeq = new Map(existing.map((e) => [e.entry.seq, e.entry]));
  let prevHash = existing.length ? existing[existing.length - 1].entry.hash : GENESIS;
  let prevLogTime = existing.length ? existing[existing.length - 1].entry.logTime : null;
  let seq = existing.length;
  let offset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const logLines = [];
  const idxLines = [];
  const written = [];
  for (const item of items) {
    const entry = {
      seq,
      prevHash,
      op: item.op,
      supersedes: item.supersedes === undefined ? null : item.supersedes,
      businessTime: item.businessTime === undefined ? Date.now() : item.businessTime,
      logTime: item.logTime === undefined ? Date.now() : item.logTime,
    };
    entry.hash = hashEntry(key, entry);
    const err = validateEntry(key, entry, prevHash, prevLogTime, bySeq);
    if (err) throw new Error('entry ' + seq + ': ' + err);
    const line = JSON.stringify(entry);
    logLines.push(line);
    idxLines.push(JSON.stringify({ seq, offset, length: Buffer.byteLength(line), hash: entry.hash }));
    offset += Buffer.byteLength(line) + 1;
    bySeq.set(seq, entry);
    prevHash = entry.hash;
    prevLogTime = entry.logTime;
    seq += 1;
    written.push(entry);
  }
  if (logLines.length) {
    fs.appendFileSync(logPath, logLines.join('\n') + '\n');
    fs.appendFileSync(idxPath, idxLines.join('\n') + '\n');
  }
  return written;
}

function appendEntry(logPath, idxPath, keyPath, op, opts) {
  return appendEntries(logPath, idxPath, keyPath, [Object.assign({ op }, opts)])[0];
}

// Current ledger view: per business key, corrections supersede their targets;
// among remaining heads the latest businessTime wins; equal businessTime on
// multiple heads of the same bizKey yields a conflict certificate.
function buildView(logPath) {
  const raw = readLog(logPath);
  if (raw.some((e) => e.entry === null)) throw new Error('log contains corrupt entries; run verify');
  const entries = raw.map((e) => e.entry);
  const groups = new Map();
  for (const entry of entries) {
    const bk = entry.op.bizKey;
    if (!groups.has(bk)) groups.set(bk, []);
    groups.get(bk).push(entry);
  }
  const accounts = new Map();
  const conflicts = [];
  const keys = {};
  for (const [bizKey, group] of groups) {
    const superseded = new Set(
      group.map((e) => e.supersedes).filter((s) => s !== null && s !== undefined));
    const heads = group.filter((e) => !superseded.has(e.seq));
    const maxBiz = Math.max(...heads.map((h) => h.businessTime));
    const winners = heads.filter((h) => h.businessTime === maxBiz);
    if (winners.length > 1) {
      const cert = {
        bizKey,
        account: winners[0].op.account,
        businessTime: maxBiz,
        candidates: winners.map((w) => ({ seq: w.seq, hash: w.hash, op: w.op })),
      };
      conflicts.push(cert);
      keys[bizKey] = { status: 'conflict', certificate: cert };
      continue;
    }
    const winner = winners[0];
    if (winner.op.type === 'tombstone') {
      keys[bizKey] = { status: 'void', by: winner.seq };
      continue;
    }
    const delta = winner.op.type === 'credit' ? winner.op.amount : -winner.op.amount;
    accounts.set(winner.op.account, (accounts.get(winner.op.account) || 0) + delta);
    keys[bizKey] = { status: 'ok', winner: winner.seq, account: winner.op.account, delta };
  }
  return { accounts: Object.fromEntries(accounts), conflicts, keys };
}

// Proof for an account: every entry touching it (with its log path = seq/offset)
// plus the full correction-ancestor closure, anchored at the log tip.
function buildProof(logPath, account) {
  const logEntries = readLog(logPath);
  if (logEntries.some((e) => e.entry === null)) throw new Error('log contains corrupt entries; run verify');
  const pack = (e) => ({
    seq: e.entry.seq,
    offset: e.offset,
    hash: e.entry.hash,
    prevHash: e.entry.prevHash,
    op: e.entry.op,
    supersedes: e.entry.supersedes === undefined ? null : e.entry.supersedes,
    businessTime: e.entry.businessTime,
    logTime: e.entry.logTime,
  });
  const mine = logEntries.filter((e) => e.entry.op.account === account).map(pack);
  const bySeq = new Map(logEntries.map((e) => [e.entry.seq, e]));
  const mineSeqs = new Set(mine.map((m) => m.seq));
  const ancestors = new Map();
  for (const m of mine) {
    let cur = m;
    while (cur.supersedes !== null && cur.supersedes !== undefined) {
      const anc = bySeq.get(cur.supersedes);
      if (!anc) break;
      if (!mineSeqs.has(anc.entry.seq) && !ancestors.has(anc.entry.seq)) {
        ancestors.set(anc.entry.seq, pack(anc));
      }
      cur = pack(anc);
    }
  }
  const tip = logEntries.length ? logEntries[logEntries.length - 1].entry : null;
  return {
    version: 1,
    account,
    tipSeq: tip ? tip.seq : -1,
    tipHash: tip ? tip.hash : GENESIS,
    entries: mine,
    ancestors: [...ancestors.values()],
  };
}

// Independent recomputation of a proof against the log.
function verifyProof(logPath, keyPath, proof) {
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  const logEntries = readLog(logPath);
  const hashes = [];
  let prevHash = GENESIS;
  for (const e of logEntries) {
    if (e.entry === null) return { ok: false, reason: 'corrupt entry at offset ' + e.offset };
    if (e.entry.prevHash !== prevHash) {
      return { ok: false, reason: 'chain broken at seq ' + e.entry.seq };
    }
    const h = hashEntry(key, e.entry);
    if (h !== e.entry.hash) {
      return { ok: false, reason: 'hash mismatch at seq ' + e.entry.seq };
    }
    hashes.push(h);
    prevHash = h;
  }
  const tipSeq = logEntries.length ? logEntries.length - 1 : -1;
  if (proof.tipSeq !== tipSeq || proof.tipHash !== prevHash) {
    return { ok: false, reason: 'tip mismatch: proof is not anchored at the current log tip' };
  }
  const entrySeqs = new Set(proof.entries.map((e) => e.seq));
  const ancestorSeqs = new Set(proof.ancestors.map((a) => a.seq));
  for (const e of proof.entries) {
    if (e.seq < 0 || e.seq >= hashes.length || hashes[e.seq] !== e.hash) {
      return { ok: false, reason: 'entry hash mismatch at seq ' + e.seq };
    }
    if (logEntries[e.seq].entry.op.account !== proof.account) {
      return { ok: false, reason: 'entry ' + e.seq + ' does not belong to account ' + proof.account };
    }
    if (e.supersedes !== null && e.supersedes !== undefined
        && !entrySeqs.has(e.supersedes) && !ancestorSeqs.has(e.supersedes)) {
      return { ok: false, reason: 'missing correction ancestor for seq ' + e.seq };
    }
  }
  for (const a of proof.ancestors) {
    if (a.seq < 0 || a.seq >= hashes.length || hashes[a.seq] !== a.hash) {
      return { ok: false, reason: 'ancestor hash mismatch at seq ' + a.seq };
    }
  }
  return { ok: true, account: proof.account, entries: proof.entries.length, ancestors: proof.ancestors.length };
}

module.exports = {
  TIME_WINDOW_MS, GENESIS, canonical, hashEntry, readLog, verify, recover,
  appendEntry, appendEntries, buildView, buildProof, verifyProof, getOrCreateKey,
};
