import fs from 'node:fs';
import {
  encodeBlock,
  decodeBlock,
  peekVersion,
  blockHash,
  sha256,
  TYPE_SNAPSHOT,
  TYPE_DELTA,
  ZERO_HASH,
} from './block.js';
import { initialState, applyOp } from './state.js';
import { BusinessError, CorruptError } from './errors.js';

export const SNAPSHOT_INTERVAL = 5;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

export function stateRoot(state) {
  return sha256(Buffer.from(JSON.stringify(canonical(state)))).toString('hex');
}

function parseJsonPayload(block, what) {
  try {
    return JSON.parse(block.payload.toString('utf8'));
  } catch {
    throw new CorruptError(`undecodable ${what} at offset ${block.offset}`);
  }
}

export class Store {
  constructor(file) {
    this.file = file;
    this.indexFile = `${file}.idx`;
    this.certFile = `${file}.cert`;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  init(total) {
    if (this.exists()) throw new BusinessError(`ledger already exists: ${this.file}`);
    const state = initialState(total);
    const block = encodeBlock({
      version: 0,
      type: TYPE_SNAPSHOT,
      offset: 0,
      payload: Buffer.from(JSON.stringify(state)),
      prevHash: ZERO_HASH,
    });
    fs.writeFileSync(this.file, block);
    const index = {
      latestSnapshot: { version: 0, offset: 0 },
      snapshots: [{ version: 0, offset: 0 }],
      versions: {},
    };
    this._commit(index, 0, state, blockHash(block));
    return { version: 0 };
  }

  _readIndex() {
    try {
      return JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch (err) {
      throw new CorruptError(`cannot read index: ${err.message}`);
    }
  }

  _readCert() {
    try {
      return JSON.parse(fs.readFileSync(this.certFile, 'utf8'));
    } catch (err) {
      throw new CorruptError(`cannot read certificate: ${err.message}`);
    }
  }

  _commit(index, version, state, lastHash) {
    fs.writeFileSync(this.indexFile, JSON.stringify(index, null, 2));
    const indexHash = sha256(fs.readFileSync(this.indexFile)).toString('hex');
    const cert = {
      version,
      stateRoot: stateRoot(state),
      chainHash: lastHash.toString('hex'),
      snapshotOffset: index.latestSnapshot.offset,
      indexHash,
    };
    fs.writeFileSync(this.certFile, JSON.stringify(cert, null, 2));
    return cert;
  }

  // Applies a business op, appends a delta block (plus a snapshot block every
  // SNAPSHOT_INTERVAL versions) and rewrites index + certificate.
  appendOp(op) {
    if (!this.exists()) throw new BusinessError(`ledger not initialized: ${this.file}`);
    const cert = this._readCert();
    const state = this.restore(cert.version);
    const result = applyOp(state, op); // throws BusinessError before any write
    const version = cert.version + 1;

    const size = fs.statSync(this.file).size;
    const prevHash = Buffer.from(cert.chainHash, 'hex');
    const delta = encodeBlock({
      version,
      type: TYPE_DELTA,
      offset: size,
      payload: Buffer.from(JSON.stringify(op)),
      prevHash,
    });
    fs.appendFileSync(this.file, delta);
    let lastHash = blockHash(delta);

    const index = this._readIndex();
    index.versions[String(version)] = size;

    if (version % SNAPSHOT_INTERVAL === 0) {
      const snapOffset = size + delta.length;
      const snap = encodeBlock({
        version,
        type: TYPE_SNAPSHOT,
        offset: snapOffset,
        payload: Buffer.from(JSON.stringify(state)),
        prevHash: lastHash,
      });
      fs.appendFileSync(this.file, snap);
      lastHash = blockHash(snap);
      index.snapshots.push({ version, offset: snapOffset });
      index.latestSnapshot = { version, offset: snapOffset };
    }

    this._commit(index, version, state, lastHash);
    return { version, ...result };
  }

  // Reconstructs the state at `targetVersion`.
  //
  // State is rebuilt from the latest snapshot at or before the target plus
  // the following delta blocks; blocks with version > targetVersion are never
  // read (the walk stops at the first header beyond the target). Every block
  // up to the target is CRC- and chain-validated, so any corruption at a
  // version <= target aborts with CorruptError and no partial state escapes.
  restore(targetVersion) {
    if (!Number.isInteger(targetVersion) || targetVersion < 0) {
      throw new BusinessError(`invalid version: ${targetVersion}`);
    }
    if (!this.exists()) throw new CorruptError(`ledger file missing: ${this.file}`);
    const cert = this._readCert();
    if (targetVersion > cert.version) {
      throw new BusinessError(`unknown version ${targetVersion}, latest is ${cert.version}`);
    }

    const buf = fs.readFileSync(this.file);
    let offset = 0;
    let prevHash = ZERO_HASH;
    let state = null;
    let baseVersion = -1;

    while (offset < buf.length) {
      if (peekVersion(buf, offset) > targetVersion) break;
      const block = decodeBlock(buf, offset, prevHash);
      prevHash = block.hash;
      offset += block.length;
      if (block.type === TYPE_SNAPSHOT && block.version >= baseVersion) {
        state = parseJsonPayload(block, 'snapshot');
        baseVersion = block.version;
      } else if (block.type === TYPE_DELTA && block.version > baseVersion) {
        applyOp(state, parseJsonPayload(block, 'delta'));
      }
    }
    if (state === null) throw new CorruptError('no snapshot found');
    return state;
  }

  // Decodes and validates every block in the file, then cross-checks the
  // certificate (chain hash) and the index hash recorded in it.
  verify() {
    if (!this.exists()) throw new CorruptError(`ledger file missing: ${this.file}`);
    const buf = fs.readFileSync(this.file);
    let offset = 0;
    let prevHash = ZERO_HASH;
    let blocks = 0;
    let maxVersion = -1;
    let lastHash = ZERO_HASH;
    while (offset < buf.length) {
      const block = decodeBlock(buf, offset, prevHash);
      prevHash = block.hash;
      lastHash = block.hash;
      maxVersion = Math.max(maxVersion, block.version);
      offset += block.length;
      blocks += 1;
    }
    const cert = this._readCert();
    if (cert.chainHash !== lastHash.toString('hex')) {
      throw new CorruptError('certificate chain hash does not match last block');
    }
    const indexHash = sha256(fs.readFileSync(this.indexFile)).toString('hex');
    if (cert.indexHash !== indexHash) {
      throw new CorruptError('certificate index hash does not match index file');
    }
    return { blocks, version: maxVersion, chainHash: cert.chainHash, stateRoot: cert.stateRoot };
  }
}
