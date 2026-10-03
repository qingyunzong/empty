'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { readFileSync, openSync, closeSync, unlinkSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  solve,
  validate,
  Planner,
  PlannerError,
  canonicalAssignmentKey,
} = require('../src/planner');
const {
  buildCertificate,
  verifyCertificate,
  solveWithCertificate,
  certificateHash,
} = require('../src/certificate');
const { referenceSolve, solutionKey } = require('../support/reference');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');

function loadExample(name) {
  return JSON.parse(readFileSync(path.join(ROOT, 'examples', name), 'utf8'));
}

let cliCounter = 0;

// The sandbox blocks piped stdio for child processes, so the CLI's stdout is
// captured through a temporary file instead.
function runCli(args) {
  return new Promise((resolve, reject) => {
    cliCounter += 1;
    const outFile = path.join(os.tmpdir(), `planner-cli-${process.pid}-${cliCounter}.out`);
    const fd = openSync(outFile, 'w');
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', fd, fd] });
    child.on('error', reject);
    child.on('close', (code) => {
      closeSync(fd);
      const stdout = readFileSync(outFile, 'utf8');
      unlinkSync(outFile);
      resolve({ status: code, stdout });
    });
  });
}

test('acceptance 1: 9-order instance matches the branch-and-bound reference', () => {
  const instance = loadExample('nine-orders.json');
  const planner = solve(instance, { enumerate: true, maxOptima: 100000 });
  const reference = referenceSolve(instance);

  assert.equal(planner.status, 'OPTIMAL');
  assert.deepEqual(planner.objective, { completed: 9, overtime: 0, switches: 7 });
  assert.deepEqual(planner.objective, reference.objective);

  // All tied optima enumerated by both engines must be identical sets.
  assert.equal(planner.truncated, false);
  const plannerKeys = new Set(planner.optima.map(canonicalAssignmentKey));
  const referenceKeys = new Set(reference.optima.map(solutionKey));
  assert.equal(plannerKeys.size, referenceKeys.size);
  for (const key of referenceKeys) assert.ok(plannerKeys.has(key), `missing optimum: ${key}`);
});

test('acceptance 2: kit qty off by one returns a verifiable conflict certificate', () => {
  const instance = loadExample('kit-shortage.json');
  const result = solveWithCertificate(instance, { requireAll: true });

  assert.equal(result.status, 'UNSAT');
  const cert = result.certificate;
  assert.ok(cert, 'certificate must be attached');
  assert.deepEqual(cert.orders, ['O1', 'O2']);
  assert.deepEqual(cert.bottleneck, { kind: 'kit', id: 'KA', have: 1, need: 2 });
  assert.equal(cert.unverified, undefined);

  // The certificate is independently verifiable against the instance.
  const verification = verifyCertificate(instance, cert);
  assert.equal(verification.ok, true, JSON.stringify(verification.checks));

  // Hash is stable and reproducible.
  assert.equal(cert.hash, certificateHash(cert));
  const rebuilt = buildCertificate(instance);
  assert.equal(rebuilt.hash, cert.hash);

  // Off by one: with qty bumped to `need` the same orders become feasible.
  const fixed = {
    ...instance,
    kits: instance.kits.map((k) => (k.id === 'KA' ? { ...k, qty: cert.bottleneck.need } : k)),
  };
  const resolved = solve(fixed, { requireAll: true });
  assert.equal(resolved.status, 'OPTIMAL');
  assert.equal(resolved.objective.completed, 2);
});

test('acceptance 3: lock one assignment, re-solve, unlock restores the full solve', () => {
  const instance = loadExample('nine-orders.json');
  const planner = new Planner(instance);

  const full = planner.solve({ enumerate: true, maxOptima: 100000 });
  assert.equal(full.status, 'OPTIMAL');

  const locked = full.assignments[0];
  planner.lock(locked.order, { tech: locked.tech, start: locked.start });
  const resolved = planner.solve({ enumerate: true, maxOptima: 100000 });

  // Locking an assignment of an optimal solution keeps the same optimum.
  assert.equal(resolved.status, 'OPTIMAL');
  assert.deepEqual(resolved.objective, full.objective);
  assert.ok(
    resolved.assignments.some(
      (a) => a.order === locked.order && a.tech === locked.tech && a.start === locked.start,
    ),
    'locked assignment must be present in the re-solved result',
  );
  for (const optimum of resolved.optima) {
    assert.ok(
      optimum.some(
        (a) => a.order === locked.order && a.tech === locked.tech && a.start === locked.start,
      ),
      'every enumerated optimum must respect the lock',
    );
  }

  // Unlocking fully restores the original solve.
  planner.unlock(locked.order);
  const restored = planner.solve({ enumerate: true, maxOptima: 100000 });
  assert.deepEqual(restored, full);
});

test('acceptance 4: window end earlier than start is rejected with ERR_WINDOW', async () => {
  const badOrder = loadExample('bad-window.json');
  assert.throws(() => validate(badOrder), (err) => err instanceof PlannerError && err.code === 'ERR_WINDOW');
  assert.throws(() => solve(badOrder), (err) => err.code === 'ERR_WINDOW');

  const badShift = {
    orders: [{ id: 'O1', duration: 30, window: [0, 60], parts: [], skill: 'mech' }],
    techs: [{ id: 'T1', shifts: [[200, 100]], skills: ['mech'] }],
    kits: [],
  };
  assert.throws(() => solve(badShift), (err) => err.code === 'ERR_WINDOW');

  const cli = await runCli([path.join(ROOT, 'examples', 'bad-window.json')]);
  assert.equal(cli.status, 1);
  const out = JSON.parse(cli.stdout);
  assert.equal(out.error.code, 'ERR_WINDOW');
});

test('UNKNOWN from a node limit is never reported as infeasible', () => {
  const instance = loadExample('nine-orders.json');
  const result = solveWithCertificate(instance, { requireAll: true, nodeLimit: 5 });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.certificate, undefined);
  assert.notEqual(result.status, 'UNSAT');
});

test('CLI: optimal solve prints JSON with objective and assignments', async () => {
  const cli = await runCli([path.join(ROOT, 'examples', 'nine-orders.json'), '--enumerate']);
  assert.equal(cli.status, 0, cli.stderr);
  const out = JSON.parse(cli.stdout);
  assert.equal(out.status, 'OPTIMAL');
  assert.deepEqual(out.objective, { completed: 9, overtime: 0, switches: 7 });
  assert.equal(out.assignments.length, 9);
  assert.equal(out.optimaCount, 72);
  assert.equal(out.truncated, false);
});

test('CLI: UNSAT solve prints the certificate and its hash, verifiable on demand', async () => {
  const target = path.join(ROOT, 'examples', 'kit-shortage.json');
  const cli = await runCli([target, '--require-all', '--verify']);
  assert.equal(cli.status, 0, cli.stderr);
  const out = JSON.parse(cli.stdout);
  assert.equal(out.status, 'UNSAT');
  assert.equal(out.certificateHash, out.certificate.hash);
  assert.match(out.certificateHash, /^[0-9a-f]{64}$/);
  assert.equal(out.certificateVerification.ok, true);

  const instance = loadExample('kit-shortage.json');
  assert.equal(verifyCertificate(instance, out.certificate).ok, true);
});

test('CLI: lock flag constrains the re-solve', async () => {
  const target = path.join(ROOT, 'examples', 'nine-orders.json');
  const cli = await runCli([target, '--lock', 'O1:T2:0']);
  assert.equal(cli.status, 0, cli.stderr);
  const out = JSON.parse(cli.stdout);
  assert.equal(out.status, 'OPTIMAL');
  assert.equal(out.objective.completed, 9);
  const o1 = out.assignments.find((a) => a.order === 'O1');
  assert.equal(o1.tech, 'T2');
  assert.equal(o1.start, 0);
});

test('kit occupation and release couple across orders', () => {
  // Two orders share one kit unit; the second can only start after the first
  // returns the kit, even though two techs are free.
  const instance = {
    orders: [
      { id: 'O1', duration: 60, window: [0, 120], parts: ['pA'], skill: 'mech' },
      { id: 'O2', duration: 60, window: [0, 120], parts: ['pA'], skill: 'mech' },
    ],
    techs: [
      { id: 'T1', shifts: [[0, 600]], skills: ['mech'] },
      { id: 'T2', shifts: [[0, 600]], skills: ['mech'] },
    ],
    kits: [{ id: 'KA', qty: 1, compatible: ['pA'] }],
  };
  const result = solve(instance, { requireAll: true });
  assert.equal(result.status, 'OPTIMAL');
  const o1 = result.assignments.find((a) => a.order === 'O1');
  const o2 = result.assignments.find((a) => a.order === 'O2');
  assert.ok(o1.end <= o2.start || o2.end <= o1.start, 'kit unit must be returned before reuse');
});

test('overtime is minimized after completed count', () => {
  // Both orders fit only if one runs partly outside the single shift.
  const instance = {
    orders: [
      { id: 'O1', duration: 60, window: [0, 120], parts: [], skill: 'mech' },
      { id: 'O2', duration: 60, window: [60, 180], parts: [], skill: 'mech' },
    ],
    techs: [{ id: 'T1', shifts: [[0, 90]], skills: ['mech'] }],
    kits: [],
  };
  const result = solve(instance);
  assert.equal(result.status, 'OPTIMAL');
  assert.equal(result.objective.completed, 2);
  // O1 takes [0,60) inside the shift; O2 takes [60,120) with 30 min uncovered.
  assert.equal(result.objective.overtime, 30);
});
