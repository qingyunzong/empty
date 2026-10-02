import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Scheduler } from '../src/scheduler.js';
import * as R from '../src/rational.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

// ---------- helpers ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

function randomTasks(rand, n) {
  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    const release = R.rat(BigInt(randInt(rand, 0, 6)), BigInt(randInt(rand, 1, 3)));
    const window = R.rat(BigInt(randInt(rand, 1, 4)), BigInt(randInt(rand, 1, 2)));
    const duration = R.rat(BigInt(randInt(rand, 1, 3)), BigInt(randInt(rand, 1, 2)));
    tasks.push({
      id: `t${i}`,
      release,
      deadline: R.add(release, window),
      duration,
      weight: R.rat(BigInt(randInt(rand, 1, 6))),
    });
  }
  return tasks;
}

function lexIds(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

// Reference: enumerate every subset and every permutation; a subset is feasible
// iff some permutation admits an earliest-start schedule meeting all deadlines.
function bruteForce(tasks) {
  const n = tasks.length;
  const checkOrder = (perm) => {
    let cur = null;
    for (const i of perm) {
      const t = tasks[i];
      const start = cur === null ? t.release : R.max(cur, t.release);
      const end = R.add(start, t.duration);
      if (R.gt(end, t.deadline)) return false;
      cur = end;
    }
    return true;
  };
  const feasible = (sub) => {
    const a = sub.slice();
    const permute = (l) => {
      if (l === a.length - 1) return checkOrder(a);
      for (let i = l; i < a.length; i += 1) {
        [a[l], a[i]] = [a[i], a[l]];
        if (permute(l + 1)) return true;
        [a[l], a[i]] = [a[i], a[l]];
      }
      return false;
    };
    return a.length === 0 ? true : permute(0);
  };
  let bestW = null;
  let bestIds = null;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    const sub = [];
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) sub.push(i);
    if (!feasible(sub)) continue;
    const w = sub.reduce((acc, i) => R.add(acc, tasks[i].weight), R.zero());
    const ids = sub.map((i) => tasks[i].id).sort();
    if (bestW === null || R.gt(w, bestW) || (R.eq(w, bestW) && lexIds(ids, bestIds) < 0)) {
      bestW = w;
      bestIds = ids;
    }
  }
  return { weight: bestW, ids: bestIds };
}

function checkScheduleShape(tasks, sol) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const selected = new Set(sol.jobs.map((j) => j.id));
  // jobs within windows, non-overlapping in output order
  let prevEnd = null;
  for (const j of sol.jobs) {
    const t = byId.get(j.id);
    const start = R.parse(j.start);
    const end = R.parse(j.end);
    assert.ok(R.ge(start, t.release), `${j.id} starts before release`);
    assert.ok(R.le(end, t.deadline), `${j.id} ends after deadline`);
    assert.ok(R.eq(R.add(start, t.duration), end), `${j.id} duration mismatch`);
    if (prevEnd) assert.ok(R.le(prevEnd, start), 'jobs overlap');
    prevEnd = end;
  }
  // certificate matches window-overlap definition
  for (const t of tasks) {
    const expected = tasks
      .filter((s) => selected.has(s.id))
      .filter((s) => R.lt(R.max(t.release, s.release), R.min(t.deadline, s.deadline)))
      .map((s) => s.id)
      .sort();
    if (selected.has(t.id)) {
      assert.equal(sol.certificate[t.id], undefined);
    } else {
      assert.deepEqual(sol.certificate[t.id], expected, `certificate for ${t.id}`);
    }
  }
}

// ---------- acceptance 1: cross-check vs subset/permutation enumeration ----------

test('overlapping windows: solver matches brute force for n<=8', () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const rand = mulberry32(seed);
    const n = randInt(rand, 1, 8);
    const tasks = randomTasks(rand, n);
    const sched = new Scheduler();
    for (const t of tasks) {
      const res = sched.add({ ...t, release: R.format(t.release), deadline: R.format(t.deadline), duration: R.format(t.duration), weight: R.format(t.weight) });
      assert.equal(res.ok, true);
    }
    const sol = sched.solve();
    const ref = bruteForce(tasks);
    assert.equal(sol.weight, R.format(ref.weight), `weight mismatch seed=${seed} n=${n}`);
    assert.deepEqual(sol.jobs.map((j) => j.id).sort(), ref.ids, `selection mismatch seed=${seed} n=${n}`);
    checkScheduleShape(tasks, sol);
  }
});

test('three overlapping windows: only the best pair is chosen', () => {
  const s = new Scheduler();
  s.add({ id: 'a', release: '0', deadline: '2', duration: '3/2', weight: '5' });
  s.add({ id: 'b', release: '0', deadline: '2', duration: '3/2', weight: '4' });
  s.add({ id: 'c', release: '1/2', deadline: '3', duration: '1', weight: '3' });
  const sol = s.solve();
  // a+c and b+c are feasible (weight 8 and 7); a+b are not (3 > 2 window each).
  assert.equal(sol.weight, '8');
  assert.deepEqual(sol.jobs.map((j) => j.id), ['a', 'c']);
  assert.deepEqual(sol.certificate.b, ['a', 'c']);
});

// ---------- acceptance 2: tangent boundaries ----------

test('tangent windows [0,1] and [1,2] chain; shrinking to overlap fails', () => {
  const s = new Scheduler();
  s.add({ id: 'a', release: '0', deadline: '1', duration: '1', weight: '1' });
  s.add({ id: 'b', release: '1', deadline: '2', duration: '1', weight: '1' });
  let sol = s.solve();
  assert.equal(sol.weight, '2');
  assert.deepEqual(sol.jobs, [
    { id: 'a', start: '0', end: '1' },
    { id: 'b', start: '1', end: '2' },
  ]);
  assert.deepEqual(sol.certificate, {});

  // Move b into (0,1): both now need the full unit slot and cannot coexist.
  const upd = s.update('b', { release: '0', deadline: '1' });
  assert.equal(upd.ok, true);
  sol = s.solve();
  assert.equal(sol.weight, '1');
  assert.equal(sol.jobs.length, 1);
  const kept = sol.jobs[0].id;
  const dropped = kept === 'a' ? 'b' : 'a';
  assert.deepEqual(sol.certificate[dropped], [kept]);
});

// ---------- acceptance 3: tie via update, undo/redo consistency ----------

test('update creates a tie; undo/redo restore identical state and certificate', () => {
  const s = new Scheduler();
  s.add({ id: 'a', release: '0', deadline: '1', duration: '1', weight: '1' });
  s.add({ id: 'b', release: '0', deadline: '1', duration: '1', weight: '2' });
  let sol = s.solve();
  assert.equal(sol.weight, '2');
  assert.deepEqual(sol.jobs.map((j) => j.id), ['b']);
  assert.deepEqual(sol.certificate, { a: ['b'] });

  // Tie at weight 1: lexicographically smallest selection {a} wins.
  assert.equal(s.update('b', { weight: '1' }).ok, true);
  const tied = s.solve();
  assert.equal(tied.weight, '1');
  assert.deepEqual(tied.jobs.map((j) => j.id), ['a']);
  assert.deepEqual(tied.certificate, { b: ['a'] });
  const tiedState = s.state();
  const tiedVersion = s.version;

  assert.deepEqual(s.undo(), { ok: true, version: tiedVersion - 1 });
  sol = s.solve();
  assert.equal(sol.weight, '2');
  assert.deepEqual(sol.jobs.map((j) => j.id), ['b']);

  assert.deepEqual(s.redo(), { ok: true, version: tiedVersion });
  assert.deepEqual(s.state(), tiedState);
  assert.deepEqual(s.solve(), tied);
});

// ---------- acceptance 4: invalid input creates no version ----------

test('invalid add/update are rejected without a new version', () => {
  const s = new Scheduler();
  s.add({ id: 'a', release: '0', deadline: '2', duration: '1', weight: '1' });
  s.add({ id: 'b', release: '0', deadline: '1', duration: '1', weight: '1' });
  const v0 = s.version;
  const before = { state: s.state(), solve: s.solve() };

  const cases = [
    [() => s.update('a', { release: '1/0' }), 'E_RATIONAL'],
    [() => s.update('a', { deadline: '0/0' }), 'E_RATIONAL'],
    [() => s.update('a', { duration: '2/0' }), 'E_RATIONAL'],
    [() => s.update('a', { weight: '1/0' }), 'E_RATIONAL'],
    [() => s.update('a', { release: 0.5 }), 'E_RATIONAL'], // floats forbidden
    [() => s.update('a', { release: '3', deadline: '1' }), 'E_EMPTY'],
    [() => s.update('a', { release: '2', deadline: '1/2' }), 'E_EMPTY'],
    [() => s.update('a', { duration: '0' }), 'E_EMPTY'],
    [() => s.update('a', { duration: '-1/2' }), 'E_EMPTY'],
    [() => s.add({ id: 'c', release: '1/0', deadline: '2', duration: '1', weight: '1' }), 'E_RATIONAL'],
    [() => s.add({ id: 'c', release: '2', deadline: '1', duration: '1', weight: '1' }), 'E_EMPTY'],
    [() => s.add({ id: 'c', release: '0', deadline: '2', duration: '0', weight: '1' }), 'E_EMPTY'],
  ];
  for (const [fn, code] of cases) {
    const res = fn();
    assert.equal(res.ok, false);
    assert.equal(res.error, code);
    assert.equal(s.version, v0, `version changed on ${code}`);
  }
  assert.deepEqual(s.state(), before.state);
  assert.deepEqual(s.solve(), before.solve);
});

// ---------- CLI ----------

test('CLI reads JSON commands on stdin and writes single-line JSON', () => {
  const commands = [
    { op: 'add', task: { id: 'a', release: '0', deadline: '1', duration: '1', weight: '1' } },
    { op: 'add', task: { id: 'b', release: '1', deadline: '2', duration: '1', weight: '1' } },
    { op: 'solve' },
    { op: 'update', id: 'b', patch: { release: '0', deadline: '1' } },
    { op: 'solve' },
    { op: 'update', id: 'a', patch: { duration: '0' } },
    { op: 'undo' },
    { op: 'solve' },
    { op: 'redo' },
    { op: 'solve' },
  ];
  // Note: this sandbox does not deliver spawnSync `input` to child stdin,
  // so feed the CLI through a temp file and shell redirection instead.
  const inputFile = path.join(tmpdir(), `press-sched-${process.pid}.json`);
  writeFileSync(inputFile, JSON.stringify(commands));
  const res = spawnSync('sh', ['-c', `${process.execPath} ${CLI} < ${inputFile}`], { encoding: 'utf8' });
  unlinkSync(inputFile);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'stdout must be a single line');
  const out = JSON.parse(lines[0]);
  assert.equal(out.length, commands.length);
  assert.deepEqual(out[2].jobs, [
    { id: 'a', start: '0', end: '1' },
    { id: 'b', start: '1', end: '2' },
  ]);
  assert.equal(out[4].jobs.length, 1, 'overlapping pair cannot both run');
  assert.deepEqual(out[5], { ok: false, error: 'E_EMPTY' });
  assert.deepEqual(out[6], { ok: true, version: 2 });
  assert.equal(out[7].jobs.length, 2, 'undo restores tangent schedule');
  assert.deepEqual(out[8], { ok: true, version: 3 });
  assert.deepEqual(out[9], out[4], 'redo reproduces the post-update solution');
});
