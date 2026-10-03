'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FactoringStore } = require('../src/store.js');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factoring-')), 'store.json');
}

const CLUSTERED = [
  { id: 'm1', creditor: 'acme', faceValue: 1000, advanceRate: 0.5, memo: 'steel delivery contract' },
  { id: 'm2', creditor: 'acme', faceValue: 2000, advanceRate: 0.5, memo: 'steel delivery note' },
  { id: 'm3', creditor: 'acme', faceValue: 3000, advanceRate: 0.5, memo: 'delivery contract copy' },
];

test('revoking one member releases only its freeze and lists surviving members', () => {
  const store = new FactoringStore({ creditLine: 100_000, slop: 0 });
  for (const inv of CLUSTERED) store.addInvoice(inv);
  assert.equal(store.clusters().length, 1);

  const before = store.totals();
  const cert = store.revokeInvoice('m2');

  assert.equal(cert.invoiceId, 'm2');
  assert.equal(cert.releasedAmount, 2000 * 0.5);
  assert.equal(cert.clusterRemoved, false);
  assert.deepEqual(
    cert.survivingMembers.map((m) => m.id).sort(),
    ['m1', 'm3']
  );
  // Only m2's freeze is released; the cluster survives with 2 members.
  assert.equal(store.totals().frozen, before.frozen - 1000);
  assert.deepEqual(store.clusters()[0].members.sort(), ['m1', 'm3']);
  assert.equal(store.getInvoice('m2').state, 'revoked');
});

test('emptying a cluster physically removes its slot and compacts', () => {
  const store = new FactoringStore({ creditLine: 100_000, slop: 0 });
  for (const inv of CLUSTERED) store.addInvoice(inv);
  // A second, independent cluster for another creditor.
  store.addInvoice({ id: 'n1', creditor: 'beta', faceValue: 100, advanceRate: 0.5, memo: 'apple pie' });
  store.addInvoice({ id: 'n2', creditor: 'beta', faceValue: 100, advanceRate: 0.5, memo: 'apple pie' });
  assert.equal(store.clusters().length, 2);
  const betaSlotId = store.clusters().find((c) => c.creditor === 'beta').id;

  store.revokeInvoice('m1');
  store.revokeInvoice('m2');
  const last = store.revokeInvoice('m3');
  assert.equal(last.clusterRemoved, true);
  assert.equal(last.survivingMembers.length, 0);

  // No empty cluster remains; remaining slots are compacted (dense array).
  const clusters = store.clusters();
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].id, betaSlotId);
  assert.deepEqual(clusters[0].members.sort(), ['n1', 'n2']);
  assert.ok(clusters.every((c) => c.members.length >= 2));
});

test('no empty cluster residue after save and reload (restart)', () => {
  const file = tmpFile();
  const store = new FactoringStore({ creditLine: 100_000, slop: 1, file });
  for (const inv of CLUSTERED) store.addInvoice(inv);
  store.addInvoice({ id: 'solo', creditor: 'acme', faceValue: 50, advanceRate: 0.5, memo: 'nothing shared' });

  store.revokeInvoice('m1');
  store.revokeInvoice('m2');
  store.revokeInvoice('m3');
  assert.equal(store.clusters().length, 0);

  // Restart: reload from disk.
  const reloaded = FactoringStore.load(file);
  assert.equal(reloaded.clusters().length, 0);

  // Raw persistence file must not contain any empty or stale cluster slots.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.clusterSlots.length, 0);
  assert.ok(raw.clusterSlots.every((s) => s.members.length >= 2));

  // Totals survive the restart consistently.
  assert.equal(reloaded.totals().frozen, store.totals().frozen);
  assert.equal(reloaded.totals().available, store.totals().available);

  // Cluster sequence continues without reusing retired ids.
  reloaded.addInvoice({ id: 'z1', creditor: 'z', faceValue: 10, advanceRate: 0.5, memo: 'fresh pair' });
  reloaded.addInvoice({ id: 'z2', creditor: 'z', faceValue: 10, advanceRate: 0.5, memo: 'fresh pair' });
  const again = FactoringStore.load(file);
  assert.equal(again.clusters().length, 1);
  assert.deepEqual(again.clusters()[0].members.sort(), ['z1', 'z2']);
});

test('certificate for a non-clustered invoice has null cluster and no members', () => {
  const store = new FactoringStore({ creditLine: 1000, slop: 1 });
  store.addInvoice({ id: 'lone', creditor: 'c', faceValue: 100, advanceRate: 0.5, memo: 'unique' });
  const cert = store.revokeInvoice('lone');
  assert.equal(cert.clusterId, null);
  assert.equal(cert.clusterRemoved, false);
  assert.deepEqual(cert.survivingMembers, []);
  assert.equal(cert.releasedAmount, 50);
});
