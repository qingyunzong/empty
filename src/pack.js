import fs from 'node:fs';
import path from 'node:path';
import { ZERO_HASH, computeBlockHash } from './hash.js';
import { merkleRoot, merkleProof, verifyMerkleProof } from './merkle.js';

export const EXIT_CODES = Object.freeze({
  OK: 0,
  ERROR: 1,
  TAMPER_DETECTED: 2,
  MISSING_BLOCK: 3,
  INVALID_PROOF: 4,
  STALE_EPOCH: 5,
  NOT_MEMBER: 6,
  DIVERGENT: 7,
});

export class PackError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PackError';
    this.code = code;
    this.details = details;
    this.exitCode = EXIT_CODES[code] ?? EXIT_CODES.ERROR;
  }
}

export class CrashError extends Error {
  constructor(point) {
    super(`simulated crash at failpoint: ${point}`);
    this.name = 'CrashError';
    this.point = point;
  }
}

const FORMAT = 'evpack/1';
const MANIFEST = 'pack.json';
const BLOCKS_DIR = 'blocks';

const blockFile = (index) => String(index).padStart(6, '0') + '.json';

function writeFileAtomic(filePath, data) {
  const tmp = filePath + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  // Best-effort directory fsync so the rename itself is durable.
  try {
    const dfd = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* non-fatal on platforms that disallow dir fsync */ }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function initPack(dir, { members = [] } = {}) {
  if (fs.existsSync(path.join(dir, MANIFEST))) {
    throw new PackError('ERROR', `pack already exists at ${dir}`);
  }
  fs.mkdirSync(path.join(dir, BLOCKS_DIR), { recursive: true });
  const manifest = { format: FORMAT, epoch: 0, members: [...members], count: 0, tip: ZERO_HASH, digest: merkleRoot([]) };
  writeFileAtomic(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  return openPack(dir);
}

export function openPack(dir, options = {}) {
  return new Pack(dir, options);
}

export class Pack {
  constructor(dir, { failpoints = null } = {}) {
    this.dir = dir;
    // failpoints: optional Set of point names; hitting one throws CrashError
    // to simulate a process crash (no cleanup, no catch).
    this.failpoints = failpoints;
    const manifestPath = path.join(dir, MANIFEST);
    if (!fs.existsSync(manifestPath)) {
      throw new PackError('ERROR', `no pack manifest at ${manifestPath}`);
    }
    this.manifest = readJson(manifestPath);
    if (this.manifest.format !== FORMAT) {
      throw new PackError('ERROR', `unsupported pack format: ${this.manifest.format}`);
    }
    this._rollbackOrphans();
    this.leaves = [];
    for (let i = 0; i < this.manifest.count; i += 1) {
      this.leaves.push(this.readBlock(i).hash);
    }
  }

  // Remove temp files and block files beyond the committed manifest count.
  // A block whose commit record (manifest) never landed is rolled back, so a
  // crash can never leave a half-committed block visible.
  _rollbackOrphans() {
    const blocksDir = path.join(this.dir, BLOCKS_DIR);
    for (const name of fs.readdirSync(blocksDir)) {
      if (name.includes('.tmp-')) {
        fs.rmSync(path.join(blocksDir, name), { force: true });
        continue;
      }
      const m = /^(\d{6})\.json$/.exec(name);
      if (m && Number(m[1]) >= this.manifest.count) {
        fs.rmSync(path.join(blocksDir, name), { force: true });
      }
    }
  }

  _failpoint(point) {
    if (this.failpoints && this.failpoints.has(point)) {
      throw new CrashError(point);
    }
  }

  get epoch() { return this.manifest.epoch; }
  get members() { return [...this.manifest.members]; }
  get count() { return this.manifest.count; }
  get tip() { return this.manifest.tip; }
  get digest() { return this.manifest.digest; }

  summary() {
    return {
      epoch: this.manifest.epoch,
      count: this.manifest.count,
      heads: this.manifest.count > 0 ? [this.manifest.tip] : [],
      digest: this.manifest.digest,
    };
  }

  blockHashAt(index) {
    if (index < 0 || index >= this.manifest.count) {
      throw new PackError('MISSING_BLOCK', `no block at index ${index}`, { index });
    }
    return this.leaves[index];
  }

  readBlock(index) {
    const file = path.join(this.dir, BLOCKS_DIR, blockFile(index));
    if (!fs.existsSync(file)) {
      throw new PackError('MISSING_BLOCK', `block file missing at index ${index}`, { index });
    }
    let block;
    try {
      block = readJson(file);
    } catch {
      throw new PackError('TAMPER_DETECTED', `block ${index} is not valid JSON`, { index });
    }
    return block;
  }

  _checkWriter(member, epoch) {
    if (epoch !== undefined && epoch !== this.manifest.epoch) {
      throw new PackError('STALE_EPOCH',
        `writer epoch ${epoch} is stale; current epoch is ${this.manifest.epoch}`,
        { writerEpoch: epoch, currentEpoch: this.manifest.epoch });
    }
    if (!this.manifest.members.includes(member)) {
      throw new PackError('NOT_MEMBER', `member "${member}" is not in the current member set`, { member });
    }
  }

  // Two-phase atomic commit:
  //   phase 1: block file  -> tmp + fsync + rename
  //   phase 2: commit record (manifest) -> tmp + fsync + rename
  // A crash before phase 2 leaves an orphan block that _rollbackOrphans()
  // removes on next open; a crash after phase 2 implies phase 1 completed.
  _commitBlock(block, nextManifest) {
    this._failpoint('before-block-commit');
    writeFileAtomic(path.join(this.dir, BLOCKS_DIR, blockFile(block.index)), JSON.stringify(block, null, 2));
    this._failpoint('before-manifest-commit');
    writeFileAtomic(path.join(this.dir, MANIFEST), JSON.stringify(nextManifest, null, 2));
    this._failpoint('after-manifest-commit');
    this.manifest = nextManifest;
    this.leaves.push(block.hash);
  }

  _appendBlock(kind, payload) {
    const block = {
      index: this.manifest.count,
      epoch: this.manifest.epoch,
      prev: this.manifest.tip,
      kind,
      payload,
    };
    block.hash = computeBlockHash(block);
    const leaves = [...this.leaves, block.hash];
    const nextManifest = {
      ...this.manifest,
      count: this.manifest.count + 1,
      tip: block.hash,
      digest: merkleRoot(leaves),
    };
    this._commitBlock(block, nextManifest);
    return block;
  }

  add(payload, { member, epoch } = {}) {
    this._checkWriter(member, epoch);
    return this._appendBlock('evidence', payload);
  }

  // Membership change: appends an epoch block and raises the epoch barrier.
  // Writes carrying the old epoch are rejected afterwards; old blocks stay readable.
  setMembers(members, { member, epoch } = {}) {
    this._checkWriter(member, epoch);
    const nextEpoch = this.manifest.epoch + 1;
    const block = this._appendBlock('epoch', { epoch: nextEpoch, members: [...members] });
    // The epoch block itself is committed under the old epoch; now raise the barrier.
    const nextManifest = { ...this.manifest, epoch: nextEpoch, members: [...members] };
    writeFileAtomic(path.join(this.dir, MANIFEST), JSON.stringify(nextManifest, null, 2));
    this.manifest = nextManifest;
    return block;
  }

  prove(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.manifest.count) {
      throw new PackError('MISSING_BLOCK', `no block at index ${index}`, { index });
    }
    return {
      index,
      hash: this.leaves[index],
      count: this.manifest.count,
      epoch: this.manifest.epoch,
      digest: this.manifest.digest,
      proof: merkleProof(this.leaves, index),
    };
  }

  // Verify an inclusion proof object against this pack's digest (or an override).
  verifyProof(proofObj, digestOverride) {
    const expected = digestOverride ?? this.manifest.digest;
    const ok = proofObj
      && typeof proofObj === 'object'
      && proofObj.digest === expected
      && verifyMerkleProof({
        blockHash: proofObj.hash,
        index: proofObj.index,
        count: proofObj.count,
        proof: proofObj.proof,
        root: expected,
      });
    if (!ok) {
      throw new PackError('INVALID_PROOF', 'inclusion proof does not verify against the pack digest',
        { index: proofObj?.index ?? null });
    }
    return { ok: true, index: proofObj.index, digest: expected };
  }

  // Full offline verification: recompute every block hash, the chain linkage,
  // epoch monotonicity, and the Merkle root; compare against the manifest.
  verify() {
    const { count } = this.manifest;
    let prev = ZERO_HASH;
    let lastEpoch = 0;
    const leaves = [];
    for (let i = 0; i < count; i += 1) {
      const block = this.readBlock(i); // throws MISSING_BLOCK / TAMPER_DETECTED
      if (block.index !== i) {
        throw new PackError('TAMPER_DETECTED', `block ${i} has wrong index field ${block.index}`, { index: i });
      }
      const recomputed = computeBlockHash(block);
      if (block.hash !== recomputed) {
        throw new PackError('TAMPER_DETECTED', `block ${i} hash mismatch`, { index: i, expected: recomputed, actual: block.hash });
      }
      if (block.prev !== prev) {
        throw new PackError('TAMPER_DETECTED', `block ${i} chain linkage broken`, { index: i });
      }
      if (block.epoch < lastEpoch) {
        throw new PackError('TAMPER_DETECTED', `block ${i} epoch moved backwards`, { index: i });
      }
      prev = block.hash;
      lastEpoch = block.epoch;
      leaves.push(block.hash);
    }
    if (this.manifest.tip !== prev) {
      throw new PackError('TAMPER_DETECTED', 'manifest tip does not match chain head', { index: count > 0 ? count - 1 : null });
    }
    const root = merkleRoot(leaves);
    if (root !== this.manifest.digest) {
      throw new PackError('TAMPER_DETECTED', 'manifest digest does not match recomputed Merkle root', { index: null });
    }
    return { ok: true, count, epoch: this.manifest.epoch, digest: root, tip: this.manifest.tip };
  }

  // Anti-entropy pull from a peer pack. Exchanges {epoch, heads, digest}
  // summaries, checks prefix consistency, then pulls the missing interval
  // [count, peer.count). Idempotent: a converged pull is a no-op.
  syncFrom(peer) {
    const remote = peer.summary();
    const local = this.summary();
    if (remote.count <= local.count) {
      // Nothing to pull, but still detect divergent histories: the peer's
      // tip must match our hash at the same height.
      if (remote.count > 0 && peer.blockHashAt(remote.count - 1) !== this.leaves[remote.count - 1]) {
        throw new PackError('DIVERGENT', 'peer history conflicts with local history', { localCount: local.count });
      }
      return { pulled: 0, from: local.count, to: local.count, digest: this.digest, converged: remote.digest === local.digest };
    }
    if (local.count > 0 && peer.blockHashAt(local.count - 1) !== local.heads[0]) {
      throw new PackError('DIVERGENT', 'peer history conflicts with local history', { localCount: local.count });
    }
    let pulled = 0;
    for (let i = local.count; i < remote.count; i += 1) {
      const block = peer.readBlock(i);
      const recomputed = computeBlockHash(block);
      if (block.hash !== recomputed || block.index !== i || block.prev !== this.manifest.tip) {
        throw new PackError('TAMPER_DETECTED', `peer block ${i} failed validation during sync`, { index: i });
      }
      this._commitBlock(block, {
        ...this.manifest,
        count: i + 1,
        tip: block.hash,
        digest: merkleRoot([...this.leaves, block.hash]),
      });
      pulled += 1;
    }
    // Adopt membership/epoch state carried by the newer history.
    if (remote.epoch > this.manifest.epoch) {
      const nextManifest = { ...this.manifest, epoch: remote.epoch, members: peer.members };
      writeFileAtomic(path.join(this.dir, MANIFEST), JSON.stringify(nextManifest, null, 2));
      this.manifest = nextManifest;
    }
    if (this.manifest.digest !== remote.digest) {
      throw new PackError('TAMPER_DETECTED', 'post-sync digest does not match peer digest');
    }
    return { pulled, from: local.count, to: remote.count, digest: this.digest, converged: true };
  }
}
