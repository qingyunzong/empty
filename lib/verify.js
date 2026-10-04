import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { recomputeCertHash } from './certs.js';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Verifies every per-batch hash chain in an output directory:
// hashes recompute, seq numbers are contiguous from 1, prev_hash links
// match, and exactly the latest certificate is unrevoked.
export function verifyOutDir(outDir) {
  const errors = [];
  const indexPath = path.join(outDir, 'index.json');
  if (!existsSync(indexPath)) {
    return { ok: false, errors: [`index.json not found in ${outDir}`] };
  }
  const index = readJson(indexPath);

  for (const [batchId, entry] of Object.entries(index.batches ?? {})) {
    const chain = [...entry.history, { ...entry.current, revoked: false }];
    for (let i = 0; i < chain.length; i += 1) {
      const link = chain[i];
      const file = path.join(outDir, link.file);
      let cert;
      try {
        cert = readJson(file);
      } catch {
        errors.push(`${batchId}: cannot read cert file ${link.file}`);
        continue;
      }
      if (cert.hash !== link.hash) {
        errors.push(`${batchId}: index hash mismatch for ${link.file}`);
      }
      if (recomputeCertHash(cert) !== cert.hash) {
        errors.push(`${batchId}: cert ${link.file} hash does not recompute`);
      }
      if (cert.seq !== i + 1) {
        errors.push(`${batchId}: cert ${link.file} has seq ${cert.seq}, expected ${i + 1}`);
      }
      const expectedPrev = i === 0 ? null : chain[i - 1].hash;
      if (cert.prev_hash !== expectedPrev) {
        errors.push(`${batchId}: cert ${link.file} prev_hash does not link the chain`);
      }
      const shouldBeRevoked = i < chain.length - 1;
      if (cert.revoked !== shouldBeRevoked) {
        errors.push(
          `${batchId}: cert ${link.file} revoked=${cert.revoked}, expected ${shouldBeRevoked}`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// A certificate is usable only if it is the current, unrevoked head of
// its batch chain.
export function isUsable(outDir, batchId, hash) {
  const index = readJson(path.join(outDir, 'index.json'));
  const entry = index.batches?.[batchId];
  if (!entry) return false;
  if (entry.current.hash !== hash) return false;
  const cert = readJson(path.join(outDir, entry.current.file));
  return cert.revoked === false;
}

export function listCertFiles(outDir) {
  return readdirSync(outDir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort();
}
