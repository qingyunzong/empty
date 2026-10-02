import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256hex } from './canon.js';
import { merkleRoot } from './merkle.js';
import { PackError, Code } from './errors.js';

export const ZERO_HASH = '0'.repeat(64);

export function commitFile(dir) { return path.join(dir, 'commit.json'); }
export function epochFile(dir) { return path.join(dir, 'epoch.json'); }
export function blocksDir(dir) { return path.join(dir, 'blocks'); }
export function blockFile(dir, index) {
  return path.join(blocksDir(dir), String(index).padStart(8, '0') + '.json');
}

// Atomic write: tmp file + fsync + rename + dir fsync. A crash leaves either
// the old file or an un-renamed tmp file, never a half-written target.
export function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dfd = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new PackError(Code.IO, `cannot read ${what}`, { file });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PackError(Code.TAMPER_DETECTED, `corrupt ${what}`, { file });
  }
}

export function initPack(dir, members = []) {
  fs.mkdirSync(blocksDir(dir), { recursive: true });
  if (!fs.existsSync(epochFile(dir))) {
    atomicWriteJson(epochFile(dir), { epoch: 1, members });
  }
  if (!fs.existsSync(commitFile(dir))) {
    atomicWriteJson(commitFile(dir), {
      epoch: 1, length: 0, head: ZERO_HASH, root: merkleRoot([]),
    });
  }
  return { dir };
}

export function loadCommit(dir) {
  return readJson(commitFile(dir), 'commit record');
}

export function loadEpoch(dir) {
  return readJson(epochFile(dir), 'epoch record');
}

export function writeEpoch(dir, epochRec) {
  atomicWriteJson(epochFile(dir), epochRec);
}

export function writeCommit(dir, commit) {
  atomicWriteJson(commitFile(dir), commit);
}

// Membership change: bumps epoch, creating a barrier for old-epoch writes.
export function setMembership(dir, members) {
  const cur = loadEpoch(dir);
  const next = { epoch: cur.epoch + 1, members };
  writeEpoch(dir, next);
  return next;
}

export function blockExists(dir, index) {
  return fs.existsSync(blockFile(dir, index));
}

export function readBlock(dir, index) {
  const file = blockFile(dir, index);
  if (!fs.existsSync(file)) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new PackError(Code.IO, 'cannot read block', { index });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PackError(Code.TAMPER_DETECTED, 'unparseable block file', { index, file });
  }
}

export function writeBlock(dir, block) {
  atomicWriteJson(blockFile(dir, block.index), block);
}

export function removeBlock(dir, index) {
  try { fs.rmSync(blockFile(dir, index)); } catch { /* already gone */ }
}

export function hashBlock(block) {
  return sha256hex(canonical({
    index: block.index, epoch: block.epoch, prev: block.prev, data: block.data,
  }));
}

function readAllHashes(dir, length) {
  const hashes = [];
  for (let i = 0; i < length; i++) {
    const block = readBlock(dir, i);
    if (block === null) {
      throw new PackError(Code.MISSING_BLOCK, 'block file missing', { index: i });
    }
    hashes.push(block.hash);
  }
  return hashes;
}

// Append one evidence block. Ordering guarantees no half-committed state:
//   1. block file persisted (tmp+rename)
//   2. commit record persisted (tmp+rename)
// A crash between the two leaves an orphan block beyond commit.length,
// which every reader ignores.
export function appendBlock(dir, data) {
  const commit = loadCommit(dir);
  const epochRec = loadEpoch(dir);
  const block = {
    index: commit.length,
    epoch: epochRec.epoch,
    prev: commit.head,
    data,
  };
  block.hash = hashBlock(block);
  writeBlock(dir, block);
  const hashes = readAllHashes(dir, commit.length);
  hashes.push(block.hash);
  const next = {
    epoch: epochRec.epoch,
    length: commit.length + 1,
    head: block.hash,
    root: merkleRoot(hashes),
  };
  writeCommit(dir, next);
  return { block, commit: next };
}

// Full integrity check: hash chain from genesis, head, and Merkle root
// recomputed from block files and compared against the commit record.
// Blocks beyond commit.length (crash orphans) are ignored.
export function verifyPack(dir) {
  const commit = loadCommit(dir);
  const epochRec = loadEpoch(dir);
  const hashes = [];
  let prev = ZERO_HASH;
  for (let i = 0; i < commit.length; i++) {
    const block = readBlock(dir, i);
    if (block === null) {
      throw new PackError(Code.MISSING_BLOCK, 'block file missing', { index: i });
    }
    if (block.index !== i) {
      throw new PackError(Code.TAMPER_DETECTED, 'block index mismatch', { index: i });
    }
    if (block.prev !== prev) {
      throw new PackError(Code.TAMPER_DETECTED, 'hash chain broken', { index: i });
    }
    const h = hashBlock(block);
    if (h !== block.hash) {
      throw new PackError(Code.TAMPER_DETECTED, 'block hash mismatch', { index: i });
    }
    hashes.push(h);
    prev = h;
  }
  if (prev !== commit.head) {
    throw new PackError(Code.TAMPER_DETECTED, 'head mismatch vs commit record', {});
  }
  const root = merkleRoot(hashes);
  if (root !== commit.root) {
    throw new PackError(Code.TAMPER_DETECTED, 'merkle root mismatch vs commit record', {});
  }
  return { commit, epoch: epochRec, hashes };
}

export function digest(dir) {
  const commit = loadCommit(dir);
  const epochRec = loadEpoch(dir);
  let missing = 0;
  for (let i = 0; i < commit.length; i++) {
    if (!blockExists(dir, i)) missing++;
  }
  return {
    epoch: epochRec.epoch,
    members: epochRec.members,
    length: commit.length,
    head: commit.head,
    root: commit.root,
    missing,
  };
}
