import test from 'node:test';
import assert from 'node:assert/strict';
import { CertStore } from '../src/store.js';

// Deterministic PRNG so failures are reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const QUERY_TIME = '2026-06-01T00:00:00.000Z';
const DAY = 24 * 3600 * 1000;

function isoOffset(days) {
  return new Date(Date.parse(QUERY_TIME) + days * DAY).toISOString();
}

// Independent brute-force enumeration of every simple chain from any
// trusted root to `payer`, used to cross-check CertStore.verifyPayment.
function bruteForceChains(certs, roots, payer) {
  const byIssuer = new Map();
  for (const cert of certs) {
    const list = byIssuer.get(cert.issuer);
    if (list) list.push(cert);
    else byIssuer.set(cert.issuer, [cert]);
  }
  const out = [];
  const stack = roots.map((root) => ({ rootId: root, current: root, path: [], seen: new Set([root]) }));
  while (stack.length > 0) {
    const { rootId, current, path, seen } = stack.pop();
    for (const cert of byIssuer.get(current) ?? []) {
      if (seen.has(cert.subject)) continue;
      const nextPath = [...path, cert];
      if (cert.subject === payer) {
        out.push({ rootId, chain: nextPath });
      } else {
        stack.push({ rootId, current: cert.subject, path: nextPath, seen: new Set([...seen, cert.subject]) });
      }
    }
  }
  return out;
}

function chainUsable(store, chain, amount, time) {
  const at = Date.parse(time);
  return chain.every(
    (cert) =>
      cert.maxAmount >= amount &&
      Date.parse(cert.notBefore) <= at &&
      at <= Date.parse(cert.notAfter) &&
      !store.isRevokedAt(cert.id, time),
  );
}

for (let n = 2; n <= 7; n++) {
  test(`n=${n}: verifyPayment matches brute-force enumeration of all simple chains`, () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = lcg(n * 1000 + seed);
      const store = new CertStore();
      const names = Array.from({ length: n }, (_, i) => `p${i}`);
      store.issueCert({
        issuer: 'p0', subject: 'p0', maxAmount: 1_000_000,
        notBefore: isoOffset(-400), notAfter: isoOffset(400), root: true,
      });
      // random delegation graph, possibly disconnected / cyclic
      const edgeCount = n * 2;
      for (let i = 0; i < edgeCount; i++) {
        const issuer = names[Math.floor(rand() * n)];
        const subject = names[Math.floor(rand() * n)];
        if (issuer === subject) continue;
        const maxAmount = [10, 50, 100, 200, 1000][Math.floor(rand() * 5)];
        const notBefore = isoOffset(Math.floor(rand() * 60) - 40);
        const notAfter = isoOffset(Math.floor(rand() * 60) - 10);
        if (Date.parse(notBefore) > Date.parse(notAfter)) continue;
        try {
          store.issueCert({ issuer, subject, maxAmount, notBefore, notAfter });
        } catch (err) {
          assert.equal(err.code, 'CERT_EXISTS');
        }
      }
      // randomly revoke ~20% of certificates before the query time
      for (const cert of store.certs.values()) {
        if (cert.issuer === cert.subject) continue;
        if (rand() < 0.2) {
          store.revoke({ certId: cert.id, time: isoOffset(-1) });
        }
      }
      const payer = names[Math.floor(rand() * n)];
      const amount = [1, 25, 75, 150, 500][Math.floor(rand() * 5)];

      const certs = [...store.certs.values()];
      const roots = [...store.trustedRoots];
      const validChains = bruteForceChains(certs, roots, payer).filter(({ chain }) =>
        chainUsable(store, chain, amount, QUERY_TIME),
      );
      if (roots.includes(payer)) {
        validChains.push({ rootId: payer, chain: [] }); // root pays directly
      }

      let auth = null;
      let failure = null;
      try {
        auth = store.verifyPayment({ payer, payee: 'shop', amount, time: QUERY_TIME });
      } catch (err) {
        failure = err;
      }

      if (validChains.length > 0) {
        assert.ifError(failure, `seed ${seed}: expected a valid chain, got ${failure?.code}`);
        const foundIds = auth.chain.map((c) => c.id).join(',');
        const match = validChains.some(
          ({ rootId, chain }) =>
            rootId === auth.rootId && chain.map((c) => c.id).join(',') === foundIds,
        );
        assert.ok(match, `seed ${seed}: returned chain must be one of the brute-forced chains`);
        assert.equal(store.verifyAuthorization(auth), true);
      } else {
        assert.ok(failure, `seed ${seed}: expected failure, got a chain`);
        assert.match(failure.code, /^(UNKNOWN_ROOT|CERT_REVOKED|CERT_EXPIRED|CERT_NOT_YET_VALID|AMOUNT_EXCEEDED|BAD_SIGNATURE)$/);
      }
    }
  });
}

test('enumeration picks an alternative chain when the shortest is revoked', () => {
  const store = new CertStore();
  const w = { notBefore: isoOffset(-10), notAfter: isoOffset(10) };
  store.issueCert({ issuer: 'r', subject: 'r', maxAmount: 1000, ...w, root: true });
  const direct = store.issueCert({ issuer: 'r', subject: 'a', maxAmount: 100, ...w });
  store.issueCert({ issuer: 'r', subject: 'b', maxAmount: 100, ...w });
  store.issueCert({ issuer: 'b', subject: 'a', maxAmount: 100, ...w });
  store.revoke({ certId: direct.id, time: isoOffset(-1) });
  const auth = store.verifyPayment({ payer: 'a', payee: 'shop', amount: 50, time: QUERY_TIME });
  assert.deepEqual(auth.chain.map((c) => c.subject), ['b', 'a']);
});
