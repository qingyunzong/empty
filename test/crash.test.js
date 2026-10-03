import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Chain, EVENTS_FILE, MANIFEST_FILE } from '../lib/chain.js';
import { snapshot } from '../lib/snapshot.js';

async function freshDir() {
  return mkdtemp(path.join(tmpdir(), 'custody-crash-'));
}

async function buildChain(dir, n = 3) {
  const chain = await Chain.open(dir);
  for (let i = 0; i < n; i++) {
    await chain.append({ type: 'receive', sampleId: `S${i}`, consentId: `C${i}` });
  }
  return chain;
}

test('crash mid-snapshot: orphan tmp manifest is cleaned, head stays at old head', async (t) => {
  const dir = await freshDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chain = await buildChain(dir);
  const oldHead = chain.head;

  await writeFile(path.join(dir, MANIFEST_FILE + '.tmp'), '{"version":1,"seq":2,"headHa');

  const recovered = await Chain.open(dir);
  assert.deepEqual(recovered.head, oldHead, 'chain head unchanged after torn snapshot');
  assert.equal(recovered.manifest, null, 'no half-written manifest is adopted');
  assert.equal(recovered.verify(), true);
  const names = await readdir(dir);
  assert.ok(!names.some((n) => n.endsWith('.tmp')), 'tmp files cleaned on recovery');
});

test('crash after manifest rename but events lost: dangling manifest discarded, old head kept', async (t) => {
  const dir = await freshDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chain = await buildChain(dir, 3);
  const oldHead = chain.head;

  await writeFile(
    path.join(dir, MANIFEST_FILE),
    JSON.stringify({ version: 1, seq: 7, headHash: 'a'.repeat(64), merkleRoot: 'b'.repeat(64), eventCount: 8 }) + '\n'
  );

  const recovered = await Chain.open(dir);
  assert.deepEqual(recovered.head, oldHead, 'head stays at old valid head');
  assert.equal(recovered.manifest, null, 'inconsistent manifest removed');
  assert.equal(recovered.verify(), true);
});

test('crash mid-event-append: torn tail truncated, head returns to last valid event', async (t) => {
  const dir = await freshDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chain = await buildChain(dir, 3);
  const oldHead = chain.head;

  await appendFile(path.join(dir, EVENTS_FILE), '{"seq":3,"type":"transfer","sampleId":"S');

  const recovered = await Chain.open(dir);
  assert.deepEqual(recovered.head, oldHead, 'torn event dropped, head back to last valid');
  assert.equal(recovered.events.length, 3);
  assert.equal(recovered.verify(), true);

  const raw = await readFile(path.join(dir, EVENTS_FILE), 'utf8');
  assert.equal(raw.trim().split('\n').length, 3, 'torn bytes physically truncated');
});

test('committed snapshot survives recovery: head matches manifest', async (t) => {
  const dir = await freshDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chain = await buildChain(dir, 4);
  const manifest = await snapshot(chain);

  const recovered = await Chain.open(dir);
  assert.deepEqual(recovered.head, { seq: manifest.seq, hash: manifest.headHash });
  assert.deepEqual(recovered.manifest, manifest, 'valid manifest retained');
  assert.equal(recovered.verify(), true);
});

test('events appended after snapshot keep chain valid; manifest still consistent prefix', async (t) => {
  const dir = await freshDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chain = await buildChain(dir, 2);
  const manifest = await snapshot(chain);
  await chain.append({ type: 'transfer', sampleId: 'S0', consentId: 'C0' });

  const recovered = await Chain.open(dir);
  assert.equal(recovered.events.length, 3);
  assert.deepEqual(recovered.manifest, manifest, 'older snapshot remains a valid defined point');
  assert.equal(recovered.verify(), true);
});
