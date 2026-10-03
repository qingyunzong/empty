import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendRecord, dedupeByHash, canonicalOrder, chainHead, verifyRecords, canonical,
} from '../src/index.js';
import { mulberry32, shuffle } from './helpers.js';

// Independent re-implementation used as the cross-check oracle.
function independentEnumerate(records) {
  const bySite = new Map();
  for (const r of records) {
    if (!bySite.has(r.site)) bySite.set(r.site, []);
    bySite.get(r.site).push(r);
  }
  const perSite = new Map();
  for (const [site, list] of bySite) {
    const sorted = [...list].sort((a, b) => a.vc[site] - b.vc[site]);
    for (let i = 0; i < sorted.length; i += 1) {
      assert.equal(sorted[i].vc[site], i + 1, `site ${site} chain must be contiguous`);
      if (i === 0) assert.equal(sorted[i].prev, null);
      else assert.equal(sorted[i].prev, sorted[i - 1].hash);
    }
    perSite.set(site, sorted.map((r) => r.hash));
  }
  const head = createHash('sha256')
    .update(canonical(records.map((r) => r.hash).sort()), 'utf8')
    .digest('hex');
  return { head, perSite, total: records.length };
}

test('acceptance 4: random <=9-step runs cross-checked against independent enumeration', () => {
  const rand = mulberry32(20261004);
  const sites = ['S1', 'S2', 'S3'];
  const types = ['step', 'deviation'];

  for (let trial = 0; trial < 300; trial += 1) {
    const steps = 1 + Math.floor(rand() * 9); // 1..9 records total
    const logs = new Map(sites.map((s) => [s, []]));
    const all = [];
    for (let i = 0; i < steps; i += 1) {
      const site = sites[Math.floor(rand() * sites.length)];
      const type = types[Math.floor(rand() * types.length)];
      const record = appendRecord(logs.get(site), {
        type, site, gen: 1,
        payload: { seq: i, note: `t${trial}` },
      });
      logs.get(site).push(record);
      all.push(record);
    }

    const merged = dedupeByHash(shuffle(all, rand));
    const oracle = independentEnumerate(merged);

    // library head matches independent enumeration
    assert.equal(chainHead(merged), oracle.head);

    // verifier agrees: complete, ok, no gaps
    const { exitCode, certificate } = verifyRecords(merged);
    assert.equal(exitCode, 0);
    assert.equal(certificate.status, 'ok');
    assert.deepEqual(certificate.missing, []);
    assert.equal(certificate.head, oracle.head);
    assert.equal(certificate.records, oracle.total);

    // canonical replay order respects causality: every prev appears before its child
    const order = canonicalOrder(merged);
    const position = new Map(order.map((r, idx) => [r.hash, idx]));
    for (const r of order) {
      if (r.prev !== null) assert.ok(position.get(r.prev) < position.get(r.hash));
    }
  }
});
