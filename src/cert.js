import { createHash } from 'node:crypto';
import { IndexError, E_CERT } from './errors.js';

export function sha256hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// Sorted root hash: terms are iterated in dictionary (lexicographic) order;
// each term contributes sha256(term \0 canonical-postings-json).
export function computeRootHash(termEntries) {
  const root = createHash('sha256');
  for (const { term, entries } of termEntries) {
    root.update(sha256hex(`${term}\0${JSON.stringify(entries)}`));
  }
  return root.digest('hex');
}

export function hashCert(cert) {
  const { seq, termCount, docCount, deletionCount, rootHash, prevHash } = cert;
  return sha256hex(
    JSON.stringify({ seq, termCount, docCount, deletionCount, rootHash, prevHash }),
  );
}

// Validates the append-only certificate chain: every certificate commits to
// the hash of its predecessor, so an old certificate proves the history that
// led to any later one.
export function verifyChain(certs) {
  for (let i = 0; i < certs.length; i += 1) {
    const cert = certs[i];
    if (cert.seq !== i) {
      throw new IndexError(E_CERT, `certificate sequence gap at ${i}`);
    }
    const expectedPrev = i === 0 ? null : hashCert(certs[i - 1]);
    if (cert.prevHash !== expectedPrev) {
      throw new IndexError(E_CERT, `certificate chain broken at seq ${i}`);
    }
  }
  return true;
}
