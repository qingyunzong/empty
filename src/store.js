import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalize } from './canonical.js';
import { ZERO_HASH, hashRecord } from './hash.js';

export class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

const WAL_FILE = 'wal.log';
const LOCK_FILE = 'lock';
const STATE_DIR = 'state';
const INDEX_DIR = 'index';

function walPath(dir) { return path.join(dir, WAL_FILE); }
function lockPath(dir) { return path.join(dir, LOCK_FILE); }
function stateFile(dir, version) {
  return path.join(dir, STATE_DIR, 'v' + String(version).padStart(6, '0') + '.json');
}
function headFile(dir) { return path.join(dir, STATE_DIR, 'head.json'); }
function indexFile(dir, party) {
  return path.join(dir, INDEX_DIR, encodeURIComponent(party) + '.json');
}

export function genesisState() {
  return { version: 0, transactions: {}, balances: {} };
}

function genesisOp() {
  return { txId: 'genesis', type: 'genesis', version: 0 };
}

function makeCertificate({ version, parentVersion, snapshotVersion, op, prevCertHash }) {
  const cert = {
    version,
    parentVersion,
    snapshotVersion,
    opHash: hashRecord(op),
    prevCertHash,
  };
  cert.digest = hashRecord(cert);
  return cert;
}

function appendWalSync(dir, record) {
  const fd = fs.openSync(walPath(dir), 'a');
  try {
    fs.writeSync(fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readWal(dir) {
  const file = walPath(dir);
  if (!fs.existsSync(file)) {
    throw new AuditError('E_NOT_FOUND', `no WAL at ${file}`);
  }
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

function writeStateSync(dir, state) {
  const file = stateFile(dir, state.version);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
  const headTmp = headFile(dir) + '.tmp';
  fs.writeFileSync(headTmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(headTmp, headFile(dir));
}

export function loadStateAt(dir, version) {
  const file = stateFile(dir, version);
  if (!fs.existsSync(file)) {
    throw new AuditError('E_NOT_FOUND', `no snapshot for version ${version}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadHeadState(dir) {
  if (!fs.existsSync(headFile(dir))) {
    throw new AuditError('E_NOT_FOUND', `store at ${dir} is not initialized`);
  }
  return JSON.parse(fs.readFileSync(headFile(dir), 'utf8'));
}

function loadHeadCert(dir) {
  const records = readWal(dir);
  return records[records.length - 1].certificate;
}

function updateIndexSync(dir, op) {
  const parties = op.parties ?? [];
  for (const party of parties) {
    const file = indexFile(dir, party);
    let index = { party, entries: [] };
    if (fs.existsSync(file)) {
      index = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    const entry = { version: op.version, txId: op.txId, type: op.type };
    if (op.amount !== undefined) entry.amount = op.amount;
    if (op.reverses !== undefined) entry.reverses = op.reverses;
    if (op.party !== undefined) entry.party = op.party;
    if (op.from !== undefined) entry.from = op.from;
    if (op.to !== undefined) entry.to = op.to;
    index.entries.push(entry);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
}

export function loadIndex(dir, party) {
  const file = indexFile(dir, party);
  if (!fs.existsSync(file)) {
    return { party, entries: [] };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureDirLayout(dir) {
  fs.mkdirSync(path.join(dir, STATE_DIR), { recursive: true });
  fs.mkdirSync(path.join(dir, INDEX_DIR), { recursive: true });
}

export function initStore(dir) {
  ensureDirLayout(dir);
  if (fs.existsSync(walPath(dir))) {
    return loadHeadCert(dir);
  }
  const op = genesisOp();
  const cert = makeCertificate({
    version: 0,
    parentVersion: null,
    snapshotVersion: 0,
    op,
    prevCertHash: ZERO_HASH,
  });
  appendWalSync(dir, { seq: 0, op, certificate: cert });
  writeStateSync(dir, genesisState());
  return cert;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuditError('E_INVALID', `field "${field}" must be a non-empty string`);
  }
  return value;
}

function requireAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AuditError('E_INVALID', 'amount must be a positive finite number');
  }
  return value;
}

function ensureFreshTxId(state, txId) {
  if (state.transactions[txId] !== undefined) {
    throw new AuditError('E_CONFLICT', `transaction id "${txId}" already exists`);
  }
}

// Build the canonical operation record, validating against the current head state.
function buildOp(input, state) {
  const version = state.version + 1;
  const type = input.type;
  if (type === 'payment') {
    const party = requireString(input.party, 'party');
    const amount = requireAmount(input.amount);
    const txId = input.txId !== undefined ? requireString(input.txId, 'txId') : `tx-${version}`;
    ensureFreshTxId(state, txId);
    return { txId, type, version, party, amount, parties: [party] };
  }
  if (type === 'settlement') {
    const from = requireString(input.from, 'from');
    const to = requireString(input.to, 'to');
    if (from === to) {
      throw new AuditError('E_INVALID', 'settlement requires distinct from/to parties');
    }
    const amount = requireAmount(input.amount);
    const txId = input.txId !== undefined ? requireString(input.txId, 'txId') : `tx-${version}`;
    ensureFreshTxId(state, txId);
    return { txId, type, version, from, to, amount, parties: [from, to] };
  }
  if (type === 'reversal') {
    const reverses = requireString(input.reverses, 'reverses');
    const target = state.transactions[reverses];
    if (target === undefined) {
      throw new AuditError('E_NOT_FOUND', `transaction "${reverses}" not found`);
    }
    if (target.type === 'reversal') {
      throw new AuditError('E_INVALID', 'cannot reverse a reversal entry');
    }
    if (target.status !== 'active') {
      throw new AuditError('E_CONFLICT', `transaction "${reverses}" is already reversed`);
    }
    const txId = input.txId !== undefined ? requireString(input.txId, 'txId') : `tx-${version}`;
    ensureFreshTxId(state, txId);
    if (target.type === 'payment') {
      // Reverse entry: negative amount on the same counterparty.
      return {
        txId, type, version, reverses,
        party: target.party,
        amount: -target.amount,
        parties: [target.party],
      };
    }
    // Reverse of a settlement: funds flow back with the same magnitude.
    return {
      txId, type, version, reverses,
      from: target.to,
      to: target.from,
      amount: target.amount,
      parties: [target.to, target.from],
    };
  }
  throw new AuditError('E_INVALID', `unknown operation type "${type}"`);
}

function bump(balances, party, delta) {
  balances[party] = (balances[party] ?? 0) + delta;
}

// Pure state transition; also used by the verifier to replay the WAL.
export function applyOp(state, op) {
  switch (op.type) {
    case 'genesis':
      break;
    case 'payment': {
      state.transactions[op.txId] = {
        txId: op.txId, type: op.type, party: op.party, amount: op.amount,
        status: 'active', createdAtVersion: op.version,
        reversedAtVersion: null, reversedBy: null,
      };
      bump(state.balances, op.party, op.amount);
      break;
    }
    case 'settlement': {
      state.transactions[op.txId] = {
        txId: op.txId, type: op.type, from: op.from, to: op.to, amount: op.amount,
        status: 'active', createdAtVersion: op.version,
        reversedAtVersion: null, reversedBy: null,
      };
      bump(state.balances, op.from, -op.amount);
      bump(state.balances, op.to, op.amount);
      break;
    }
    case 'reversal': {
      const target = state.transactions[op.reverses];
      if (target === undefined || target.status !== 'active') {
        throw new AuditError('E_CONFLICT', `transaction "${op.reverses}" is not active`);
      }
      target.status = 'reversed';
      target.reversedAtVersion = op.version;
      target.reversedBy = op.txId;
      const entry = {
        txId: op.txId, type: op.type, reverses: op.reverses,
        status: 'active', createdAtVersion: op.version,
        reversedAtVersion: null, reversedBy: null,
      };
      if (op.party !== undefined) {
        entry.party = op.party;
        entry.amount = op.amount;
        bump(state.balances, op.party, op.amount);
      } else {
        entry.from = op.from;
        entry.to = op.to;
        entry.amount = op.amount;
        bump(state.balances, op.from, -op.amount);
        bump(state.balances, op.to, op.amount);
      }
      state.transactions[op.txId] = entry;
      break;
    }
    default:
      throw new AuditError('E_INVALID', `unknown operation type "${op.type}"`);
  }
  state.version = op.version;
  return state;
}

async function acquireLock(dir, timeoutMs = 5000) {
  const file = lockPath(dir);
  const start = Date.now();
  for (;;) {
    try {
      const handle = await fsp.open(file, 'wx');
      await handle.writeFile(String(process.pid));
      return async () => {
        await handle.close();
        await fsp.rm(file, { force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - start > timeoutMs) {
        throw new AuditError('E_LOCKED', 'timed out acquiring commit lock');
      }
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));
    }
  }
}

// Commit one operation as a new MVCC version. Returns the certificate.
export async function commit(dir, input) {
  initStore(dir);
  const release = await acquireLock(dir);
  try {
    const head = loadHeadState(dir);
    const headCert = loadHeadCert(dir);
    const op = buildOp(input, head);
    const next = applyOp(structuredClone(head), op);
    const cert = makeCertificate({
      version: next.version,
      parentVersion: head.version,
      snapshotVersion: next.version,
      op,
      prevCertHash: headCert.digest,
    });
    appendWalSync(dir, { seq: next.version, op, certificate: cert });
    writeStateSync(dir, next);
    updateIndexSync(dir, op);
    return cert;
  } finally {
    await release();
  }
}

export function auditParty(dir, party, atVersion = null) {
  initStore(dir);
  const head = loadHeadState(dir);
  const at = atVersion === null ? head.version : atVersion;
  if (at > head.version || at < 0) {
    throw new AuditError('E_NOT_FOUND', `no version ${at}; head is ${head.version}`);
  }
  const index = loadIndex(dir, party);
  return {
    party,
    at,
    entries: index.entries.filter((entry) => entry.version <= at),
  };
}

export { canonicalize };
