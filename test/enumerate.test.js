import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, generateKeyPair, verifyCert } from '../index.js';

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent oracle: enumerate every simple chain (no repeated principals,
// no repeated certs) from a self-signed cert to `subject` over `certs`,
// then filter by the acceptance constraints. Uses only verifyCert from the
// library plus its own DFS.
function oracleChains(certs, subject, { amount, time, trustedRoots, revokedIds }) {
  const byIssuer = new Map();
  for (const cert of certs) {
    if (!byIssuer.has(cert.issuer)) byIssuer.set(cert.issuer, []);
    byIssuer.get(cert.issuer).push(cert);
  }
  const all = [];
  const valid = [];
  const visit = (cert, chain, usedSubjects, usedCerts) => {
    chain.push(cert);
    usedCerts.add(cert.id);
    if (cert.subject === subject) {
      all.push([...chain]);
      const ok =
        chain.every((c) => verifyCert(c)) &&
        trustedRoots.has(chain[0].issuer) &&
        chain.every((c) => !revokedIds.has(c.id)) &&
        chain.every((c) => time >= c.notBefore && time <= c.notAfter) &&
        chain.every((c) => c.maxAmount >= amount);
      if (ok) valid.push([...chain]);
    } else {
      for (const next of byIssuer.get(cert.subject) ?? []) {
        if (next.issuer === next.subject) continue;
        if (usedSubjects.has(next.subject) || usedCerts.has(next.id)) continue;
        usedSubjects.add(next.subject);
        visit(next, chain, usedSubjects, usedCerts);
        usedSubjects.delete(next.subject);
      }
    }
    chain.pop();
    usedCerts.delete(cert.id);
  };
  for (const cert of certs) {
    if (cert.issuer === cert.subject) visit(cert, [], new Set([cert.subject]), new Set());
  }
  return { all, valid };
}

test('n<=7: verifyPayment agrees with brute-force enumeration of all simple chains', () => {
  const TRIALS = 30;
  for (let n = 2; n <= 7; n++) {
    for (let trial = 0; trial < TRIALS; trial++) {
      const rand = mulberry32(n * 100_000 + trial);
      const keys = Array.from({ length: n }, () => generateKeyPair());
      const store = new Store();
      store.addRoot('root', keys[0].publicKey);

      const allCerts = [];
      const issue = (issuerIdx, subjectIdx, maxAmount, notBefore, notAfter) => {
        const cert = store.issueCert({
          issuerPrivateKey: keys[issuerIdx].privateKey,
          issuerPublicKey: keys[issuerIdx].publicKey,
          subjectPublicKey: keys[subjectIdx].publicKey,
          maxAmount, notBefore, notAfter,
        });
        allCerts.push(cert);
        return cert;
      };

      // root self-cert
      issue(0, 0, 100 + Math.floor(rand() * 3) * 50, rand() < 0.5 ? 0 : 50, rand() < 0.5 ? 150 : 250);
      // random directed edges (i -> j, i != j)
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j || rand() >= 0.3) continue;
          issue(i, j, 50 + Math.floor(rand() * 4) * 50, rand() < 0.5 ? 0 : 50, rand() < 0.5 ? 150 : 250);
        }
      }
      // random revocations (some restored)
      const revokedIds = new Set();
      for (const cert of allCerts) {
        if (rand() < 0.15) {
          const { revokeId } = store.revoke(cert.id);
          revokedIds.add(cert.id);
          if (rand() < 0.5) {
            store.restore(revokeId);
            revokedIds.delete(cert.id);
          }
        }
      }

      const payer = keys[n - 1];
      const amount = 50 + Math.floor(rand() * 4) * 50;
      const time = [25, 75, 200][Math.floor(rand() * 3)];

      const oracle = oracleChains(allCerts, payer.publicKey, {
        amount, time, trustedRoots: new Set([keys[0].publicKey]), revokedIds,
      });

      // store-level enumeration must match the oracle's unconstrained count
      const storeChains = store.enumerateChains(payer.publicKey);
      assert.equal(
        storeChains.length,
        oracle.all.length,
        `n=${n} trial=${trial}: simple-chain count mismatch`,
      );

      let result = null;
      let error = null;
      try {
        result = store.verifyPayment({
          payerPublicKey: payer.publicKey,
          payerPrivateKey: payer.privateKey,
          payee: 'm', amount, time,
        });
      } catch (err) {
        error = err;
      }

      if (oracle.valid.length === 0) {
        assert.ok(error, `n=${n} trial=${trial}: expected failure, got success`);
      } else {
        assert.ok(result, `n=${n} trial=${trial}: expected success, got ${error}`);
        // returned chain must be one of the oracle's valid simple chains
        const returnedIds = result.chain.map((c) => c.id).join(',');
        const validIds = new Set(oracle.valid.map((chain) => chain.map((c) => c.id).join(',')));
        assert.ok(validIds.has(returnedIds), `n=${n} trial=${trial}: returned chain not in oracle set`);
        assert.equal(result.rootId, 'root');
      }
    }
  }
});
