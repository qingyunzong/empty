import { hashLeaf, hashNode } from './hash.js';
import { noProof } from './errors.js';

export function merkleRoot(leafHashes) {
  if (leafHashes.length === 0) return null;
  let level = leafHashes.map(hashLeaf);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(hashNode(level[i], level[i + 1]));
      else next.push(level[i]);
    }
    level = next;
  }
  return level[0];
}

export function merkleProof(leafHashes, index) {
  if (!Number.isInteger(index) || index < 0 || index >= leafHashes.length) {
    throw noProof(`no proof available for leaf index ${index}`, {
      index,
      eventCount: leafHashes.length,
    });
  }
  const path = [];
  let level = leafHashes.map(hashLeaf);
  let idx = index;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(hashNode(level[i], level[i + 1]));
        if (i === idx) path.push({ position: 'right', hash: level[i + 1] });
        else if (i + 1 === idx) path.push({ position: 'left', hash: level[i] });
      } else {
        next.push(level[i]);
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return {
    index,
    leafHash: leafHashes[index],
    root: level[0],
    eventCount: leafHashes.length,
    path,
  };
}

function expectedPositions(index, eventCount) {
  const positions = [];
  let size = eventCount;
  let idx = index;
  while (size > 1) {
    const promoted = idx === size - 1 && size % 2 === 1;
    if (!promoted) positions.push(idx % 2 === 0 ? 'right' : 'left');
    idx = Math.floor(idx / 2);
    size = Math.ceil(size / 2);
  }
  return positions;
}

export function verifyProof(proof) {
  if (!proof || typeof proof !== 'object') return false;
  const { index, leafHash, root, path, eventCount } = proof;
  if (!Number.isInteger(index) || index < 0) return false;
  if (typeof leafHash !== 'string' || typeof root !== 'string' || !Array.isArray(path)) return false;
  for (const step of path) {
    if (!step || typeof step.hash !== 'string') return false;
    if (step.position !== 'left' && step.position !== 'right') return false;
  }
  if (eventCount !== undefined) {
    if (!Number.isInteger(eventCount) || eventCount < 1 || index >= eventCount) return false;
    const expected = expectedPositions(index, eventCount);
    if (expected.length !== path.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== path[i].position) return false;
    }
  }
  let acc = hashLeaf(leafHash);
  for (const step of path) {
    acc = step.position === 'left' ? hashNode(step.hash, acc) : hashNode(acc, step.hash);
  }
  return acc === root;
}
