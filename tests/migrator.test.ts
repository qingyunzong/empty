import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionGraph } from '../src/graph.js';
import { Migrator, MigrationError } from '../src/migrator.js';
import { InMemoryFileAdapter } from '../src/memory-adapter.js';
import type { ConfigData, Migration } from '../src/types.js';

const ORIGINAL = { version: '1.0', settings: { oldKey: 'x', level: 2 } };

interface World {
  adapter: InMemoryFileAdapter;
  migrator: Migrator;
  calls: string[];
  flags: { failUp: string; failDown: string };
}

function makeWorld(): World {
  const adapter = new InMemoryFileAdapter();
  const graph = new VersionGraph();
  const calls: string[] = [];
  const flags = { failUp: '', failDown: '' };

  function makeStep(id: string, from: string, to: string,
      upFn: (c: ConfigData) => ConfigData, downFn: (c: ConfigData) => ConfigData): Migration {
    function up(c: ConfigData): ConfigData {
      calls.push(id + '.up');
      if (flags.failUp === id) throw new Error('injected up failure: ' + id);
      return upFn(c);
    }
    function down(c: ConfigData): ConfigData {
      calls.push(id + '.down');
      if (flags.failDown === id) throw new Error('injected down failure: ' + id);
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

function captureMigrationError(fn: () => void): MigrationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof MigrationError) return err;
    throw err;
  }
  throw new Error('expected a MigrationError to be thrown');
}

test('migrates across the full path and cleans up the journal', () => {
  const w = makeWorld();
  const result = w.migrator.migrate('4.0');
  assert.equal(result.version, '4.0');
  assert.deepEqual(result.settings, { newKey: 'x', level: 4, theme: 'dark' },
    'settings should have every step applied');
  assert.deepEqual(w.calls, ['m1.up', 'm2.up', 'm3.up']);
  assert.equal(w.adapter.has('journal.json'), false);
  const persisted = w.migrator.readConfig();
  assert.equal(persisted !== null && persisted.version, '4.0');
});

test('failed step rolls back applied steps in reverse order', () => {
  const w = makeWorld();
  w.flags.failUp = 'm3';
  const err = captureMigrationError(() => w.migrator.migrate('4.0'));
  assert.equal(err.phase, 'apply');
  assert.deepEqual(w.calls, ['m1.up', 'm2.up', 'm3.up', 'm2.down', 'm1.down']);
  assert.deepEqual(w.migrator.readConfig(), ORIGINAL);
  assert.equal(w.adapter.has('journal.json'), false);
});

test('rollback failure keeps the resume position in the journal', () => {
  const w = makeWorld();
  w.flags.failUp = 'm3';
  w.flags.failDown = 'm1';
  const err = captureMigrationError(() => w.migrator.migrate('4.0'));
  assert.equal(err.phase, 'rollback');

  const raw = w.adapter.read('journal.json');
  assert.notEqual(raw, null);
  const journal = JSON.parse(raw === null ? '{}' : raw);
  assert.equal(journal.status, 'rolling-back');
  assert.equal(journal.rollbackIndex, 0, 'resume position points at the failed step m1');
  assert.deepEqual(journal.path, ['m1', 'm2', 'm3']);
  const mid = w.migrator.readConfig();
  assert.equal(mid !== null && mid.version, '2.0', 'config left at the failed rollback step');

  w.flags.failDown = '';
  const restored = w.migrator.recover();
  assert.deepEqual(restored, ORIGINAL);
  assert.equal(w.adapter.has('journal.json'), false);
  assert.deepEqual(w.calls, ['m1.up', 'm2.up', 'm3.up', 'm2.down', 'm1.down', 'm1.down']);
});

test('migrate refuses to run while a journal is pending', () => {
  const w = makeWorld();
  w.flags.failUp = 'm3';
  w.flags.failDown = 'm1';
  assert.throws(() => w.migrator.migrate('4.0'), MigrationError);
  assert.equal(w.migrator.hasPending(), true);
  const err = captureMigrationError(() => w.migrator.migrate('4.0'));
  assert.equal(err.phase, 'journal');
});

test('unknown target and same-version requests', () => {
  const w = makeWorld();
  const err = captureMigrationError(() => w.migrator.migrate('9.9'));
  assert.equal(err.phase, 'plan');
  const same = w.migrator.migrate('1.0');
  assert.deepEqual(same, ORIGINAL);
  assert.equal(w.adapter.has('journal.json'), false);
});
