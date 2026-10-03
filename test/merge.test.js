'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { mergeRecords } = require('../src/merge');

const CLI = path.join(__dirname, '..', 'cli.js');

function edit(field, oldValue, newValue, extra = {}) {
  return {
    author: extra.author || 'alice',
    level: extra.level ?? 1,
    clock: extra.clock || { alice: 1 },
    field,
    old: oldValue,
    new: newValue,
  };
}

const BASE = { value: 10, quality: 'good', reviewed: false };

test('auto win: higher source level overrides lower level', () => {
  const left = [edit('value', 10, 99, { author: 'senior', level: 3, clock: { senior: 1 } })];
  const right = [edit('value', 10, 55, { author: 'junior', level: 1, clock: { junior: 5 } })];
  const { merged, decisions, conflicts } = mergeRecords(BASE, left, right);
  assert.equal(merged.value, 99);
  assert.equal(conflicts.length, 0);
  const d = decisions.find((x) => x.field === 'value');
  assert.equal(d.resolution, 'left');
  assert.match(d.reason, /source level/);
});

test('auto win: same level, newer vector timestamp wins', () => {
  const left = [edit('quality', 'good', 'great', { author: 'a', level: 2, clock: { a: 3 } })];
  const right = [edit('quality', 'good', 'bad', { author: 'b', level: 2, clock: { b: 1 } })];
  const { merged, decisions } = mergeRecords(BASE, left, right);
  assert.equal(merged.quality, 'great');
  assert.equal(decisions.find((x) => x.field === 'quality').resolution, 'left');
});

test('auto win: concurrent clocks fall back to author lexicographic order', () => {
  const left = [edit('value', 10, 1, { author: 'amy', level: 1, clock: { amy: 1 } })];
  const right = [edit('value', 10, 2, { author: 'zoe', level: 1, clock: { zoe: 1 } })];
  const { merged, decisions } = mergeRecords(BASE, left, right);
  assert.equal(merged.value, 1);
  assert.match(decisions.find((x) => x.field === 'value').reason, /lexicographic/);
});

test('identical changes on both sides merge without conflict', () => {
  const left = [edit('reviewed', false, true, { author: 'a', clock: { a: 1 } })];
  const right = [edit('reviewed', false, true, { author: 'b', clock: { b: 1 } })];
  const { merged, decisions, conflicts } = mergeRecords(BASE, left, right);
  assert.equal(merged.reviewed, true);
  assert.equal(conflicts.length, 0);
  assert.equal(decisions.find((x) => x.field === 'reviewed').resolution, 'both');
});

test('same timestamp with different values is a conflict with certificate', () => {
  const left = [edit('value', 10, 1, { author: 'amy', level: 1, clock: { shared: 2 } })];
  const right = [edit('value', 10, 2, { author: 'zoe', level: 1, clock: { shared: 2 } })];
  const { merged, conflicts } = mergeRecords(BASE, left, right);
  assert.equal(merged.value, undefined);
  assert.equal(conflicts.length, 1);
  const cert = conflicts[0];
  assert.equal(cert.field, 'value');
  assert.equal(cert.reason, 'same-timestamp');
  assert.equal(cert.base, 10);
  assert.equal(cert.left.new, 1);
  assert.equal(cert.right.new, 2);
  assert.match(cert.certificateId, /^[0-9a-f]{64}$/);
});

test('both sides setting reviewed to different booleans is always a conflict', () => {
  // even a higher level cannot override the reviewed-divergence rule
  const left = [edit('reviewed', false, true, { author: 'boss', level: 9, clock: { boss: 9 } })];
  const right = [edit('reviewed', false, false, { author: 'intern', level: 1, clock: { intern: 1 } })];
  const { conflicts } = mergeRecords(BASE, left, right);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'reviewed-divergence');
});

test('stale write: edit whose old value mismatches base loses', () => {
  // left thinks value was 5, but base says 10 -> stale
  const left = [edit('value', 5, 42, { author: 'stale-bot', level: 9, clock: { stale: 9 } })];
  const right = [edit('value', 10, 20, { author: 'fresh', level: 1, clock: { fresh: 1 } })];
  const { merged, decisions, conflicts } = mergeRecords(BASE, left, right);
  assert.equal(merged.value, 20);
  assert.equal(conflicts.length, 0);
  const d = decisions.find((x) => x.field === 'value');
  assert.equal(d.resolution, 'right');
  assert.equal(d.leftStale, true);
  assert.match(d.reason, /stale/);
});

test('stale write on an unmodified field keeps base', () => {
  const left = [edit('quality', 'wrong-old', 'x', { author: 'a', clock: { a: 1 } })];
  const { merged } = mergeRecords(BASE, left, []);
  assert.equal(merged.quality, 'good');
});

test('untouched fields stay at base value', () => {
  const { merged } = mergeRecords(BASE, [], []);
  assert.deepEqual(merged, BASE);
});

// ---- enumeration: all finite value combinations for a single field ----
// Independent expected-decision computation (does not call library internals).
function expectedDecision(baseValue, leftAction, rightAction) {
  const lChanged = leftAction !== 'keep';
  const rChanged = rightAction !== 'keep';
  const lVal = lChanged ? leftAction : baseValue;
  const rVal = rChanged ? rightAction : baseValue;
  if (!lChanged && !rChanged) return { resolution: 'base', merged: baseValue };
  if (!lChanged) return { resolution: 'right', merged: rVal };
  if (!rChanged) return { resolution: 'left', merged: lVal };
  if (lVal === rVal) return { resolution: 'both', merged: lVal };
  // both changed differently; all edits here use same level and concurrent
  // clocks with authors 'alice'/'bob', so alice (lexicographically first) wins
  return { resolution: 'left', merged: lVal };
}

function enumerateField(field, domain) {
  const actions = ['keep', ...domain];
  for (const baseValue of domain) {
    for (const leftAction of actions) {
      for (const rightAction of actions) {
        const base = { ...BASE, [field]: baseValue };
        const leftEdits =
          leftAction === 'keep'
            ? []
            : [edit(field, baseValue, leftAction, { author: 'alice', level: 1, clock: { alice: 1 } })];
        const rightEdits =
          rightAction === 'keep'
            ? []
            : [edit(field, baseValue, rightAction, { author: 'bob', level: 1, clock: { bob: 1 } })];
        const expected = expectedDecision(baseValue, leftAction, rightAction);
        const { merged, decisions, conflicts } = mergeRecords(base, leftEdits, rightEdits);
        const label = `${field}: base=${baseValue} left=${leftAction} right=${rightAction}`;
        assert.equal(conflicts.length, 0, `unexpected conflict: ${label}`);
        assert.equal(merged[field], expected.merged, `wrong value: ${label}`);
        assert.equal(
          decisions.find((x) => x.field === field).resolution,
          expected.resolution,
          `wrong resolution: ${label}`
        );
      }
    }
  }
}

test('enumeration: all value combinations for numeric field (3x4x4=48 cases)', () => {
  enumerateField('value', [0, 1, 2]);
});

test('enumeration: all value combinations for reviewed (2x3x3=18 cases, divergence conflicts)', () => {
  const domain = [true, false];
  const actions = ['keep', ...domain];
  let conflictCount = 0;
  for (const baseValue of domain) {
    for (const leftAction of actions) {
      for (const rightAction of actions) {
        const base = { ...BASE, reviewed: baseValue };
        const leftEdits =
          leftAction === 'keep'
            ? []
            : [edit('reviewed', baseValue, leftAction, { author: 'alice', level: 1, clock: { alice: 1 } })];
        const rightEdits =
          rightAction === 'keep'
            ? []
            : [edit('reviewed', baseValue, rightAction, { author: 'bob', level: 1, clock: { bob: 1 } })];
        // independent expected computation
        const lChanged = leftAction !== 'keep';
        const rChanged = rightAction !== 'keep';
        const divergentBooleans =
          lChanged && rChanged && leftAction !== rightAction;
        const { merged, conflicts } = mergeRecords(base, leftEdits, rightEdits);
        if (divergentBooleans) {
          conflictCount++;
          assert.equal(conflicts.length, 1, `expected conflict for ${leftAction}/${rightAction}`);
          assert.equal(conflicts[0].reason, 'reviewed-divergence');
        } else {
          assert.equal(conflicts.length, 0);
          const expected = expectedDecision(baseValue, leftAction, rightAction);
          assert.equal(merged.reviewed, expected.merged);
        }
      }
    }
  }
  assert.equal(conflictCount, 4, 'exactly 4 divergent-boolean combinations');
});

// ---- CLI integration ----

function runCli(base, leftEdits, rightEdits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-cli-'));
  fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(dir, 'left.json'), JSON.stringify({ edits: leftEdits }));
  fs.writeFileSync(path.join(dir, 'right.json'), JSON.stringify({ edits: rightEdits }));
  const outdir = path.join(dir, 'out');
  const result = spawnSync(process.execPath, [CLI, 'base.json', 'left.json', 'right.json', 'out'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { result, outdir };
}

test('CLI: successful merge writes merged.json and decision-log.json, exit 0', () => {
  const left = [edit('value', 10, 42, { author: 'a', level: 2, clock: { a: 1 } })];
  const right = [edit('reviewed', false, true, { author: 'b', level: 1, clock: { b: 1 } })];
  const { result, outdir } = runCli(BASE, left, right);
  assert.equal(result.status, 0, result.stderr);
  const merged = JSON.parse(fs.readFileSync(path.join(outdir, 'merged.json'), 'utf8'));
  assert.deepEqual(merged, { value: 42, quality: 'good', reviewed: true });
  const log = JSON.parse(fs.readFileSync(path.join(outdir, 'decision-log.json'), 'utf8'));
  assert.equal(log.decisions.length, 3);
  assert.equal(log.conflictCount, 0);
  assert.ok(!fs.existsSync(path.join(outdir, 'conflicts.json')));
});

test('CLI: conflict writes certificate and exits with code 2', () => {
  const left = [edit('value', 10, 1, { author: 'a', level: 1, clock: { s: 1 } })];
  const right = [edit('value', 10, 2, { author: 'b', level: 1, clock: { s: 1 } })];
  const { result, outdir } = runCli(BASE, left, right);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(!fs.existsSync(path.join(outdir, 'merged.json')));
  const certs = JSON.parse(fs.readFileSync(path.join(outdir, 'conflicts.json'), 'utf8'));
  assert.equal(certs.certificates.length, 1);
  assert.equal(certs.certificates[0].reason, 'same-timestamp');
  assert.match(certs.certificates[0].certificateId, /^[0-9a-f]{64}$/);
  const log = JSON.parse(fs.readFileSync(path.join(outdir, 'decision-log.json'), 'utf8'));
  assert.equal(log.conflictCount, 1);
  assert.equal(log.decisions.find((x) => x.field === 'value').resolution, 'conflict');
});
