'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { run: shed } = require('../cli.js');
const example = (name) => path.join(__dirname, '..', 'examples', name);

function run(args) {
  let stdout = '';
  let stderr = '';
  const code = shed(args, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { code, stdout, stderr };
}

test('optimal plan exits 0 with a verifiable plan', () => {
  const { code, stdout } = run([example('feasible.json'), '--gap', '120', '--budget', '300']);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'optimal');
  assert.ok(result.shed >= 120);
  for (const [id, stage] of Object.entries(result.plan)) {
    assert.ok(Number.isInteger(stage) && stage >= 0, `${id} stage is a non-negative integer`);
  }
});

test('infeasible model exits 1 with a minimal conflict', () => {
  const { code, stdout } = run([example('infeasible.json'), '--gap', '100', '--budget', '300']);
  assert.equal(code, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'infeasible');
  assert.ok(result.conflict.maxShed < 100);
  assert.deepEqual([...result.conflict.constraints].sort(), ['F2', 'L1']);
});

test('tiny budget exits 3 with unknown and pending loads', () => {
  const { code, stdout } = run([example('feasible.json'), '--gap', '120', '--budget', '1']);
  assert.equal(code, 3);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'unknown');
  assert.ok(result.pending.length > 0);
});

test('negative power exits 2', () => {
  const { code, stderr } = run([example('negative-power.json'), '--gap', '10']);
  assert.equal(code, 2);
  assert.match(stderr, /power must not be negative/);
});

test('unknown load in interlock exits 2', () => {
  const { code, stderr } = run([example('unknown-load.json'), '--gap', '10']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown load "L9"/);
});

test('non-integer stage exits 2', () => {
  const { code, stderr } = run([example('bad-stage.json'), '--gap', '10']);
  assert.equal(code, 2);
  assert.match(stderr, /stage must be an integer/);
});

test('missing --gap exits 2', () => {
  const { code, stderr } = run([example('feasible.json')]);
  assert.equal(code, 2);
  assert.match(stderr, /--gap/);
});
