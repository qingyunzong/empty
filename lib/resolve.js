'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256, hashFile } = require('./hash');
const { fileNameForKey } = require('./keys');
const { conflictCertHash } = require('./diff');
const { scanDir } = require('./scan');
const { loadState, mergeStates, rebuildStates, SYNC_DIR } = require('./state');
const { SyncError, ERR_READ_ONLY_TARGET } = require('./apply');

// Build a deterministic, direction-independent conflict certificate.
function buildCertificate(key, hashA, hashB, winnerHash) {
  const versions = [hashA, hashB].sort();
  return {
    type: 'conflict-certificate',
    version: 1,
    key,
    versions: [{ hash: versions[0] }, { hash: versions[1] }],
    winnerHash,
    certHash: conflictCertHash(key, hashA, hashB),
  };
}

// Resolve a conflicted key. The winner's content becomes canonical in BOTH
// dirs; the loser's content is preserved as a sidecar in BOTH dirs (内容保持双份);
// the identical certificate is written to BOTH dirs.
function resolveConflict(aDir, bDir, key, winnerSide) {
  const name = fileNameForKey(key);
  const pathA = path.join(aDir, name);
  const pathB = path.join(bDir, name);
  if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) {
    throw new Error(`conflict requires both sides present: ${key}`);
  }
  const contentA = fs.readFileSync(pathA);
  const contentB = fs.readFileSync(pathB);
  const hashA = sha256(contentA);
  const hashB = sha256(contentB);
  if (hashA === hashB) throw new Error(`no conflict for ${key}: contents identical`);

  const winnerContent = winnerSide === 'a' ? contentA : contentB;
  const loserContent = winnerSide === 'a' ? contentB : contentA;
  const winnerHash = winnerSide === 'a' ? hashA : hashB;
  const loserHash = winnerSide === 'a' ? hashB : hashA;

  const cert = buildCertificate(key, hashA, hashB, winnerHash);
  const loserName = `${key.replace(/\|/g, '_')}.conflict-${loserHash.slice(0, 8)}.csv`;

  const preScanA = scanDir(aDir);
  const preScanB = scanDir(bDir);
  const prevState = mergeStates(loadState(aDir), loadState(bDir));

  for (const dir of [aDir, bDir]) {
    try {
      fs.writeFileSync(path.join(dir, name), winnerContent);
      fs.writeFileSync(path.join(dir, loserName), loserContent);
      const certDir = path.join(dir, SYNC_DIR, 'conflicts');
      fs.mkdirSync(certDir, { recursive: true });
      fs.writeFileSync(path.join(certDir, `${cert.certHash}.json`), JSON.stringify(cert, null, 2));
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
        throw new SyncError(ERR_READ_ONLY_TARGET, `read-only target: ${dir}`);
      }
      throw err;
    }
  }
  rebuildStates(aDir, bDir, prevState, preScanA, preScanB);
  return { cert, loserName, winnerHash, loserHash, hashA, hashB };
}

module.exports = { resolveConflict, buildCertificate };
