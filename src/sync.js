import {
  loadCommit, loadEpoch, writeEpoch, writeCommit,
  blockExists, readBlock, writeBlock, removeBlock,
  hashBlock, verifyPack, digest, ZERO_HASH,
} from './store.js';
import { merkleRoot } from './merkle.js';
import { PackError, Code } from './errors.js';

// Anti-entropy between two replica directories.
// 1. Handshake: exchange {epoch, length, head, root} (digest).
// 2. Epoch barrier: the higher epoch (membership view) is adopted by both;
//    incoming blocks tagged with an older epoch are rejected (STALE_EPOCH).
// 3. Pull missing blocks: interior gaps inside the committed range, then
//    the missing tail range. Every pulled block is re-validated against the
//    chain and the peer's committed Merkle root before the local commit
//    record is advanced, so a crash never exposes a half-committed state.
// Idempotent: a second run with unchanged replicas transfers nothing.
export function syncPacks(dirA, dirB) {
  const epochA = loadEpoch(dirA);
  const epochB = loadEpoch(dirB);
  const targetEpoch = Math.max(epochA.epoch, epochB.epoch);
  if (epochA.epoch < targetEpoch) writeEpoch(dirA, epochB);
  if (epochB.epoch < targetEpoch) writeEpoch(dirB, epochA);

  const transferred = { toA: 0, toB: 0 };
  pullInto(dirA, dirB, targetEpoch, transferred, 'toA');
  pullInto(dirB, dirA, targetEpoch, transferred, 'toB');

  const digestA = digest(dirA);
  const digestB = digest(dirB);
  return {
    epoch: targetEpoch,
    transferred,
    converged: digestA.head === digestB.head
      && digestA.length === digestB.length
      && digestA.root === digestB.root
      && digestA.missing === 0 && digestB.missing === 0,
    digestA,
    digestB,
  };
}

function pullInto(dst, src, targetEpoch, transferred, key) {
  const srcCommit = loadCommit(src);
  const dstCommit = loadCommit(dst);

  // Phase 1: fill interior gaps within dst's own committed range.
  const filled = [];
  try {
    for (let i = 0; i < dstCommit.length; i++) {
      if (!blockExists(dst, i) && blockExists(src, i)) {
        const block = readBlock(src, i);
        writeBlock(dst, block);
        filled.push(i);
      }
    }
    if (filled.length > 0) verifyPack(dst);
  } catch (err) {
    for (const i of filled) removeBlock(dst, i);
    throw err;
  }
  transferred[key] += filled.length;

  // Phase 2: extend dst with src's tail, if src is strictly ahead.
  if (srcCommit.length > dstCommit.length) {
    if (dstCommit.length > 0) {
      const pivot = readBlock(src, dstCommit.length - 1);
      if (pivot === null || pivot.hash !== dstCommit.head) {
        throw new PackError(Code.CONFLICT, 'divergent chains: common prefix mismatch', {
          at: dstCommit.length - 1,
        });
      }
    }
    const copied = [];
    let prev = dstCommit.length === 0 ? ZERO_HASH : dstCommit.head;
    try {
      for (let i = dstCommit.length; i < srcCommit.length; i++) {
        const block = readBlock(src, i);
        if (block === null) {
          throw new PackError(Code.MISSING_BLOCK, 'peer missing committed block', { index: i });
        }
        if (block.epoch < targetEpoch) {
          throw new PackError(Code.STALE_EPOCH, 'block written under a stale epoch', {
            index: i, blockEpoch: block.epoch, epoch: targetEpoch,
          });
        }
        if (block.index !== i || block.prev !== prev || hashBlock(block) !== block.hash) {
          throw new PackError(Code.TAMPER_DETECTED, 'peer served invalid block', { index: i });
        }
        writeBlock(dst, block);
        copied.push(i);
        prev = block.hash;
      }
      const hashes = [];
      for (let i = 0; i < srcCommit.length; i++) hashes.push(readBlock(dst, i).hash);
      if (prev !== srcCommit.head || merkleRoot(hashes) !== srcCommit.root) {
        throw new PackError(Code.TAMPER_DETECTED, 'peer chain fails end-to-end verification', {});
      }
      // Commit record is the very last write: crash before it => orphan
      // blocks ignored; crash during it => old commit record intact.
      writeCommit(dst, {
        epoch: targetEpoch,
        length: srcCommit.length,
        head: srcCommit.head,
        root: srcCommit.root,
      });
    } catch (err) {
      for (const i of copied) removeBlock(dst, i);
      throw err;
    }
    transferred[key] += copied.length;
  } else if (srcCommit.length === dstCommit.length && srcCommit.head !== dstCommit.head) {
    throw new PackError(Code.CONFLICT, 'divergent heads at equal length', {
      length: dstCommit.length,
    });
  }
}
