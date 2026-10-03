import { CertStore } from '../src/store.js';

export const T0 = '2026-01-01T00:00:00.000Z';
export const BEFORE = '2025-01-01T00:00:00.000Z';
export const AFTER = '2027-01-01T00:00:00.000Z';

// root -> alice -> bob -> carol, with per-hop amount limits.
export function makeChain(limits = [1000, 500, 200]) {
  const store = new CertStore();
  const rootCert = store.issueCert({
    issuer: 'root', subject: 'root', maxAmount: 1_000_000,
    notBefore: BEFORE, notAfter: AFTER, root: true,
  });
  const c1 = store.issueCert({
    issuer: 'root', subject: 'alice', maxAmount: limits[0],
    notBefore: BEFORE, notAfter: AFTER,
  });
  const c2 = store.issueCert({
    issuer: 'alice', subject: 'bob', maxAmount: limits[1],
    notBefore: BEFORE, notAfter: AFTER,
  });
  const c3 = store.issueCert({
    issuer: 'bob', subject: 'carol', maxAmount: limits[2],
    notBefore: BEFORE, notAfter: AFTER,
  });
  return { store, rootCert, certs: [c1, c2, c3] };
}
