import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionGraph } from '../src/graph.js';
import { Migrator } from '../src/migrator.js';
import { InMemoryFileAdapter, PowerLossError } from '../src/memory-adapter.js';
import type { ConfigData, Migration } from '../src/types.js';

const ORIGINAL = { version: '1.0', settings: { oldKey: 'x', level: 2 } };

interface World {
  adapter: InMemoryFileAdapter;
  migrator: Migrator;
  calls: string[];
  flags: { failUp: string };
}

function makeWorld(): World {
  const adapter = new InMemoryFileAdapter();
  const graph = new VersionGraph();
  const calls: string[] = [];
  const flags = { failUp: '' };

  function makeStep(id: string, from: string, to: string,
      upFn: (c: ConfigData) => ConfigData, downFn: (c: ConfigData) => ConfigData): Migration {
    function up(c: ConfigData): ConfigData {
      calls.push(id + '.up');
      if (flags.failUp === id) throw new Error('injected up failure: ' + id);
      return upFn(c);
    }
    function down(c: ConfigData): ConfigData {
      calls.push(id + '.down');
      return downFn(c);
    }
    return { id, from, to, up, down };
  }

  graph.add(makeStep('m1', '1.0', '2.0',
    (c) => ({ version: c.version, settings: { ...c.settings, theme: 'dark' } }),
    (c) => {
      const settings = { ...c.settings };
      delete settings.theme;
      return { version: c.version, settings };
    }));
  graph.add(makeStep('m2', '2.0', '3.0',
    (c) => {
      const settings = { ...c.settings };
      settings.newKey = settings.oldKey;
      delete settings.oldKey;
      return { version: c.version, settings };
    },
    (c) => {
      const settings = { ...c.settings };
      settings.oldKey = settings.newKey;
      delete settings.newKey;
      return { version: c.version, settings };
    }));
  graph.add(makeStep('m3', '3.0', '4.0',
    (c) => ({ version: c.version, settings: { ...c.settings, level: 4 } }),
    (c) => ({ version: c.version, settings: { ...c.settings, level: 2 } })));

  adapter.write('config.json', JSON.stringify(ORIGINAL));
  const migrator = new Migrator(graph, adapter, 'config.json', 'journal.json');
  return { adapter, migrator, calls, flags };
}

test('power loss mid-migration: recover() restores the original config', () => {
  const w = makeWorld();
  // Writes: 1=journal, 2=config@2.0, 3=journal(applied=1); the 4th write
  // (config@3.0) loses power.
  w.adapter.cutPowerAfter(3);
  assert.throws(() => w.migrator.migrate('4.0'), PowerLossError);
  assert.deepEqual(w.calls, ['m1.up', 'm2.up']);

  const mid = w.migrator.readConfig();
  assert.equal(mid !== null && mid.version, '2.0');
  assert.equal(w.adapter.has('journal.json'), true);

  w.adapter.restorePower();
  const restored = w.migrator.recover();
  assert.deepEqual(restored, ORIGINAL);
  assert.deepEqual(w.migrator.readConfig(), ORIGINAL);
  assert.equal(w.adapter.has('journal.json'), false);
  assert.deepEqual(w.calls, ['m1.up', 'm2.up', 'm1.down'], 'only the persisted step is rolled back');
});

test('power loss during rollback: recover() resumes from the journaled position', () => {
  const w = makeWorld();
  w.flags.failUp = 'm2';
  // Writes: 1=journal, 2=config@2.0, 3=journal(applied=1), 4=journal(rolling-back);
  // the 5th write (rolled-back config) loses power.
  w.adapter.cutPowerAfter(4);
  assert.throws(() => w.migrator.migrate('3.0'), PowerLossError);

  const raw = w.adapter.read('journal.json');
  const journal = JSON.parse(raw === null ? '{}' : raw);
  assert.equal(journal.status, 'rolling-back');
  assert.equal(journal.rollbackIndex, 0);

  w.adapter.restorePower();
  const restored = w.migrator.recover();
  assert.deepEqual(restored, ORIGINAL);
  assert.equal(w.adapter.has('journal.json'), false);
  assert.deepEqual(w.calls, ['m1.up', 'm2.up', 'm1.down', 'm1.down']);
});

test('repeated recovery is idempotent', () => {
  const w = makeWorld();
  w.adapter.cutPowerAfter(3);
  assert.throws(() => w.migrator.migrate('4.0'), PowerLossError);
  w.adapter.restorePower();

  w.migrator.recover();
  const again = w.migrator.recover();
  const third = w.migrator.recover();
  assert.deepEqual(again, ORIGINAL);
  assert.deepEqual(third, ORIGINAL);
  assert.deepEqual(w.migrator.readConfig(), ORIGINAL);
  assert.deepEqual(w.calls, ['m1.up', 'm2.up', 'm1.down'], 'no extra rollback work on repeat recovery');
});

test('recover() with no journal is a no-op', () => {
  const w = makeWorld();
  const result = w.migrator.recover();
  assert.deepEqual(result, ORIGINAL);
  assert.deepEqual(w.calls, []);
});

test('power loss again during recovery: retry completes later', () => {
  const w = makeWorld();
  w.adapter.cutPowerAfter(3);
  assert.throws(() => w.migrator.migrate('4.0'), PowerLossError);
  w.adapter.restorePower();

  // First recovery attempt loses power again on its first write.
  w.adapter.cutPowerAfter(0);
  assert.throws(() => w.migrator.recover(), PowerLossError);
  assert.equal(w.adapter.has('journal.json'), true, 'journal survives the second outage');

  w.adapter.restorePower();
  const restored = w.migrator.recover();
  assert.deepEqual(restored, ORIGINAL);
  assert.equal(w.adapter.has('journal.json'), false);
});
