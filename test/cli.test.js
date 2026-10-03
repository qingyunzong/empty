import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'cli.js');

function setup(dir, { tasks, grants }) {
  const map = {
    width: 50,
    height: 50,
    zones: [
      { id: 'Z-OPEN', kind: 'normal', aisles: [{ id: 'A-0', shelves: [{ id: 'S-0', x: 1, y: 1 }] }] },
      { id: 'Z-RES', kind: 'restricted', aisles: [{ id: 'A-1', shelves: [{ id: 'S-1', x: 5, y: 5 }] }] },
    ],
  };
  writeFileSync(join(dir, 'map.json'), JSON.stringify(map));
  writeFileSync(join(dir, 'tasks.jsonl'), tasks.map((t) => JSON.stringify(t)).join('\n') + '\n');
  writeFileSync(join(dir, 'grants.jsonl'), grants.map((g) => JSON.stringify(g)).join('\n') + '\n');
}

function run(dir, extra = []) {
  return spawnSync(
    process.execPath,
    [cli, '--map', join(dir, 'map.json'), '--tasks', join(dir, 'tasks.jsonl'), '--grants', join(dir, 'grants.jsonl'),
     '--plan', join(dir, 'plan.jsonl'), '--deny', join(dir, 'deny.jsonl'), ...extra],
    { encoding: 'utf8' },
  );
}

function readJsonl(path) {
  const text = readFileSync(path, 'utf8').trim();
  return text ? text.split('\n').map((l) => JSON.parse(l)) : [];
}

test('CLI end-to-end: writes plan.jsonl and deny.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agv-'));
  setup(dir, {
    grants: [
      { id: 'g1', op: 'grant', subject: '*', level: 'zone', zone: 'Z-RES', event: 'e1', lamport: 1, parents: [], time: 0, from: 0, to: 100 },
    ],
    tasks: [
      { id: 'T1', target: { zone: 'Z-OPEN', aisle: 'A-0' }, dispatch: { event: 'd1', lamport: 2, parents: [], time: 1 } },
      { id: 'T2', target: { zone: 'Z-RES', aisle: 'A-1' }, dispatch: { event: 'd2', lamport: 3, parents: ['e1'], time: 50 } },
      { id: 'T3', target: { zone: 'Z-RES', aisle: 'A-1' }, dispatch: { event: 'd3', lamport: 4, parents: ['e1'], time: 500 } },
    ],
  });
  const res = run(dir);
  assert.equal(res.status, 0, res.stderr);
  const plan = readJsonl(join(dir, 'plan.jsonl'));
  const deny = readJsonl(join(dir, 'deny.jsonl'));
  assert.deepEqual(plan.map((p) => p.task).sort(), ['T1', 'T2']);
  assert.deepEqual(deny.map((d) => d.task), ['T3']);
  assert.equal(deny[0].reason, 'grant-expired-or-revoked');
});

test('CLI exit 23 on out-of-bounds task coordinate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agv-'));
  setup(dir, {
    grants: [],
    tasks: [
      { id: 'T1', target: { zone: 'Z-OPEN', x: 999, y: 0 }, dispatch: { event: 'd1', lamport: 1, parents: [], time: 1 } },
    ],
  });
  const res = run(dir);
  assert.equal(res.status, 23, res.stderr);
  assert.match(res.stderr, /out of bounds/);
});

test('CLI exit 22 on missing parent event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agv-'));
  setup(dir, {
    grants: [
      { id: 'g1', op: 'grant', subject: '*', level: 'zone', zone: 'Z-RES', event: 'e1', lamport: 1, parents: ['nope'], time: 0 },
    ],
    tasks: [],
  });
  const res = run(dir);
  assert.equal(res.status, 22, res.stderr);
  assert.match(res.stderr, /missing parent/);
});

test('CLI exit 24 on dual authorization by the same person', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agv-'));
  setup(dir, {
    grants: [],
    tasks: [
      {
        id: 'T1',
        kind: 'rescue',
        target: { zone: 'Z-RES', aisle: 'A-1' },
        dispatch: { event: 'd1', lamport: 1, parents: [], time: 1 },
        dualAuth: ['alice', 'alice'],
      },
    ],
  });
  const res = run(dir);
  assert.equal(res.status, 24, res.stderr);
  assert.match(res.stderr, /distinct/);
});
