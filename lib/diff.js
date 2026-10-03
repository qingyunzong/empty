'use strict';

const { sha256 } = require('./hash');

const ERR_TOMBSTONE_RESURRECTION = 61;

// Deterministic, direction-independent conflict certificate hash.
function conflictCertHash(key, hashA, hashB) {
  const sorted = [hashA, hashB].sort();
  return sha256(`${key}|${sorted[0]}|${sorted[1]}`);
}

// Pure per-key change computation. scanA/scanB: Map key -> {hash,size,mtimeMs,path}.
// state: {files: {key: {hash, deleted, vector}}}. No filesystem access.
function computeChanges(scanA, scanB, state) {
  const changes = [];
  const conflicts = [];
  const errors = [];
  const keys = new Set([...scanA.keys(), ...scanB.keys(), ...Object.keys(state.files || {})]);

  for (const key of [...keys].sort()) {
    const a = scanA.get(key);
    const b = scanB.get(key);
    const prev = (state.files || {})[key];
    const mtime = { a: a ? a.mtimeMs : 0, b: b ? b.mtimeMs : 0 };

    if (a && b) {
      if (a.hash === b.hash) {
        if (prev && prev.deleted && a.hash === prev.hash) {
          errors.push({ key, code: ERR_TOMBSTONE_RESURRECTION,
            message: `tombstone resurrection without new version: ${key} reappeared with deleted content ${a.hash.slice(0, 12)}` });
        } else {
          changes.push({ key, op: 'none', reason: prev && prev.deleted ? 'resurrected-both-same-new-version' : 'converged', hash: a.hash, mtime });
        }
        continue;
      }
      if (!prev) {
        conflicts.push({ key, reason: 'no-common-ancestor', hashA: a.hash, hashB: b.hash, certHash: conflictCertHash(key, a.hash, b.hash), mtime });
      } else if (prev.deleted) {
        if (a.hash === prev.hash || b.hash === prev.hash) {
          errors.push({ key, code: ERR_TOMBSTONE_RESURRECTION,
            message: `tombstone resurrection without new version: ${key} reappeared with deleted content ${prev.hash.slice(0, 12)}` });
        } else {
          conflicts.push({ key, reason: 'both-resurrected-with-different-new-versions', hashA: a.hash, hashB: b.hash, certHash: conflictCertHash(key, a.hash, b.hash), mtime });
        }
      } else {
        const aChanged = a.hash !== prev.hash;
        const bChanged = b.hash !== prev.hash;
        if (aChanged && bChanged) {
          conflicts.push({ key, reason: 'both-modified', hashA: a.hash, hashB: b.hash, certHash: conflictCertHash(key, a.hash, b.hash), mtime });
        } else if (aChanged) {
          changes.push({ key, op: 'copy', from: 'a', to: 'b', reason: 'updated-in-a', hash: a.hash, size: a.size, mtime });
        } else {
          changes.push({ key, op: 'copy', from: 'b', to: 'a', reason: 'updated-in-b', hash: b.hash, size: b.size, mtime });
        }
      }
      continue;
    }

    if (a || b) {
      const side = a ? 'a' : 'b';
      const other = a ? 'b' : 'a';
      const f = a || b;
      if (!prev) {
        changes.push({ key, op: 'copy', from: side, to: other, reason: `new-in-${side}`, hash: f.hash, size: f.size, mtime });
      } else if (prev.deleted) {
        if (f.hash === prev.hash) {
          errors.push({ key, code: ERR_TOMBSTONE_RESURRECTION,
            message: `tombstone resurrection without new version: ${key} reappeared in ${side} with deleted content ${prev.hash.slice(0, 12)}` });
        } else {
          changes.push({ key, op: 'copy', from: side, to: other, reason: `resurrected-in-${side}-new-version`, hash: f.hash, size: f.size, mtime });
        }
      } else if (f.hash === prev.hash) {
        // Present side unchanged => the other side deleted it; propagate the delete.
        changes.push({ key, op: 'delete', side, reason: `deleted-in-${other}`, hash: prev.hash, mtime });
      } else {
        // Present side modified AND other side deleted: new version wins, file is restored.
        changes.push({ key, op: 'copy', from: side, to: other, reason: `updated-in-${side}-deleted-in-${other}`, hash: f.hash, size: f.size, mtime });
      }
      continue;
    }

    // Absent on both sides.
    if (prev && !prev.deleted) {
      changes.push({ key, op: 'none', reason: 'deleted-in-both', hash: prev.hash, mtime });
    }
  }
  return { changes, conflicts, errors };
}

module.exports = { computeChanges, conflictCertHash, ERR_TOMBSTONE_RESURRECTION };
