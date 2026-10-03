import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { tmpdir, mulberry32, randomSample, randomPatch, refScan, TYPES } from './helpers.js';

// Acceptance scenario 3: delete the index directory, restart, and every query
// result must be identical to what it was before the rebuild.
test('deleting index dir triggers automatic rebuild with identical results', () => {
  const dir = tmpdir();
  const rng = mulberry32(99);
  const ref = new Map();

  let store = Store.open(dir);
  for (let i = 1; i <= 2000; i++) {
    const rec = randomSample(rng, `S${String(i).padStart(6, '0')}`);
    store.add(rec);
    ref.set(rec.id, rec);
  }
  // Mix in updates and removes so indexes carry history.
  for (let i = 0; i < 400; i++) {
    const ids = [...ref.keys()];
    const id = ids[Math.floor(rng() * ids.length)];
    if (rng() < 0.6) {
      const patch = randomPatch(rng);
      store.update(id, patch);
      ref.set(id, { ...ref.get(id), ...patch });
    } else {
      store.remove(id);
      ref.delete(id);
    }
  }
  store.close(); // flushes snapshot + index files

  const genDir = fs.readdirSync(dir).find((n) => n.startsWith('gen-'));
  const idxDir = path.join(dir, genDir, 'idx');
  assert.ok(fs.existsSync(idxDir));

  // Snapshot every query result before deleting the indexes.
  const before = { finds: new Map(), types: new Map(), ranges: [] };
  store = Store.open(dir);
  for (const id of ref.keys()) before.finds.set(id, store.find(id));
  for (const type of TYPES) before.types.set(type, store.scanByType(type));
  const ranges = [
    ['2023-01-01', '2023-12-31'],
    ['2024-01-01', '2024-12-31'],
    ['2025-01-01', '2025-12-31'],
    ['2023-06-15', '2025-06-15'],
    [null, '2024-06-30'],
    ['2024-07-01', null],
  ];
  for (const [from, to] of ranges) before.ranges.push(store.scanByDateRange(from, to));
  store.close();

  fs.rmSync(idxDir, { recursive: true, force: true });

  // Restart must not fail; indexes are rebuilt automatically.
  store = Store.open(dir);
  for (const [id, rec] of before.finds) assert.deepStrictEqual(store.find(id), rec, `find(${id})`);
  for (const [type, rows] of before.types) assert.deepStrictEqual(store.scanByType(type), rows, `type ${type}`);
  ranges.forEach(([from, to], i) => {
    assert.deepStrictEqual(store.scanByDateRange(from, to), before.ranges[i], `range ${from}..${to}`);
  });
  // And they still match the brute-force reference.
  for (const type of TYPES) assert.deepStrictEqual(store.scanByType(type), refScan(ref, { type }));
  store.close();

  // Index files were recreated on disk.
  assert.ok(fs.existsSync(path.join(idxDir, 'type.json')));
  assert.ok(fs.existsSync(path.join(idxDir, 'date.json')));
});

test('corrupt index checksum triggers rebuild', () => {
  const dir = tmpdir();
  const rng = mulberry32(5);
  let store = Store.open(dir);
  for (let i = 1; i <= 100; i++) store.add(randomSample(rng, `S${i}`));
  store.close();

  const genDir = fs.readdirSync(dir).find((n) => n.startsWith('gen-'));
  const file = path.join(dir, genDir, 'idx', 'type.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.checksum = 0; // corrupt
  fs.writeFileSync(file, JSON.stringify(doc));

  store = Store.open(dir); // must not throw; rebuilds instead
  for (const type of TYPES) {
    const expected = [...store.records.values()].filter((r) => r.type === type);
    assert.strictEqual(store.scanByType(type).length, expected.length);
  }
  store.close();
});
