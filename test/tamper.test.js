import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Chain, EVENTS_FILE } from '../lib/chain.js';
import { verifyEvents } from '../lib/chain.js';

async function freshDir() {
  return mkdtemp(path.join(tmpdir(), 'custody-tamper-'));
}

async function buildChain(dir) {
  const chain = await Chain.open(dir);
  await chain.append({ type: 'receive', sampleId: 'S1', consentId: 'C1' });
  await chain.append({ type: 'transfer', sampleId: 'S1', consentId: 'C1' });
  await chain.append({ type: 'analyze', sampleId: 'S1', consentId: 'C1' });
  await chain.append({ type: 'destroy', sampleId: 'S1', consentId: 'C1' });
  return chain;
}

test('tampering with any single event fails verification and localizes the index', async (t) => {
  for (let victim = 0; victim < 4; victim++) {
    await t.test(`tamper event #${victim}`, async () => {
      const dir = await freshDir();
      try {
        await buildChain(dir);
        const eventsPath = path.join(dir, EVENTS_FILE);
        const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n');
        const tampered = JSON.parse(lines[victim]);
        tampered.data = { ...tampered.data, injected: 'attacker-was-here' };
        lines[victim] = JSON.stringify(tampered);
        await writeFile(eventsPath, lines.join('\n') + '\n');

        const events = lines.map((l) => JSON.parse(l));
        assert.throws(
          () => verifyEvents(events),
          (err) => {
            assert.equal(err.code, 'BROKEN_CHAIN');
            assert.equal(err.details.index, victim, `failure must localize to tampered index ${victim}`);
            return true;
          }
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('tampering with stored hash is detected at that index', async (t) => {
  const dir = await freshDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await buildChain(dir);
  const eventsPath = path.join(dir, EVENTS_FILE);
  const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n');
  const tampered = JSON.parse(lines[2]);
  tampered.hash = 'f'.repeat(64);
  lines[2] = JSON.stringify(tampered);
  await writeFile(eventsPath, lines.join('\n') + '\n');

  const events = lines.map((l) => JSON.parse(l));
  assert.throws(
    () => verifyEvents(events),
    (err) => err.code === 'BROKEN_CHAIN' && err.details.index === 2
  );
});
