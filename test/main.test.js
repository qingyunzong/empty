'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ReportError,
  sourceClosure,
  buildReport,
  verifyReport,
} = require('../lib');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'report-proof-'));
}

function runCli(args, dir) {
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  try {
    const res = spawnSync(process.execPath, [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    if (res.error) throw res.error;
    return {
      status: res.status,
      stdout: fs.readFileSync(outPath, 'utf8'),
      stderr: fs.readFileSync(errPath, 'utf8'),
    };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

function baseSpec() {
  return {
    roles: {
      base: { clearance: 'internal' },
      analyst: { parents: ['base'] },
    },
    grants: [],
    units: {
      u1: { level: 'internal', data: { revenue: 100 } },
      u2: { level: 'internal', data: { revenue: 200 } },
      agg: { level: 'internal', sources: ['u1', 'u2'] },
    },
    masks: [],
    request: { role: 'analyst', unit: 'agg' },
  };
}

function maskedSpec() {
  const spec = baseSpec();
  spec.units.u2 = { level: 'secret', data: { revenue: 200, salary: 42 } };
  spec.masks = [{ id: 'm1', unit: 'u2', field: 'salary', version: 1 }];
  spec.request.masks = [{ rule: 'm1', version: 1 }];
  return spec;
}

test('1. inherited read access makes aggregate build and verify pass', () => {
  const report = buildReport(baseSpec());
  assert.deepEqual(report.proof.closure, ['agg', 'u1', 'u2']);
  assert.equal(report.output.totals.revenue, 300);
  const ruleU1 = report.proof.rulePath.find((r) => r.unit === 'u1');
  assert.equal(ruleU1.via, 'clearance');
  assert.equal(ruleU1.role, 'base');
  assert.deepEqual(ruleU1.path, ['analyst', 'base']);
  assert.ok(report.proof.canonicalHash.startsWith('sha256:'));
  const result = verifyReport(report);
  assert.equal(result.ok, true);
});

test('2. deny on one source fails with minimal over-privilege set', () => {
  const spec = baseSpec();
  spec.grants.push({ role: 'base', unit: 'u2', effect: 'deny' });
  assert.throws(
    () => buildReport(spec),
    (err) => {
      assert.ok(err instanceof ReportError);
      assert.equal(err.code, 'E_DENY');
      assert.deepEqual(err.details.minimal, ['u2']);
      return true;
    });
});

test('2b. deny wins over allow on conflict', () => {
  const spec = baseSpec();
  spec.grants.push({ role: 'analyst', unit: 'u2', effect: 'allow' });
  spec.grants.push({ role: 'base', unit: 'u2', effect: 'deny' });
  assert.throws(() => buildReport(spec), (err) => err.code === 'E_DENY');
});

test('3. mask version mismatch raises E_MASK', () => {
  const spec = maskedSpec();
  spec.request.masks = [{ rule: 'm1', version: 2 }];
  assert.throws(
    () => buildReport(spec),
    (err) => {
      assert.equal(err.code, 'E_MASK');
      assert.equal(err.details.requested, 2);
      assert.equal(err.details.current, 1);
      return true;
    });
});

test('4. revoked mask: old report still verifies, new build fails', () => {
  const spec = maskedSpec();
  const report = buildReport(spec);
  assert.equal(report.output.sources.u2.salary, '***MASKED***');
  assert.equal(verifyReport(report).ok, true);

  spec.masks[0].revoked = true;
  assert.equal(verifyReport(report).ok, true, 'old report verifies from embedded snapshot');
  assert.throws(() => buildReport(spec), (err) => err.code === 'E_MASK');
});

test('5. closure matches brute-force enumeration on small graph', () => {
  const spec = baseSpec();
  spec.units = {
    a: { level: 'public', sources: ['b', 'c'] },
    b: { level: 'public', sources: ['d'] },
    c: { level: 'public', sources: ['d', 'e'] },
    d: { level: 'public', data: { x: 1 } },
    e: { level: 'public', sources: ['d'] },
  };
  const bruteForce = (id, acc) => {
    acc.add(id);
    for (const s of spec.units[id].sources || []) bruteForce(s, acc);
    return acc;
  };
  const expected = [...bruteForce('a', new Set())].sort();
  assert.deepEqual(sourceClosure(spec, 'a'), expected);
  assert.deepEqual(sourceClosure(spec, 'a'), ['a', 'b', 'c', 'd', 'e']);
});

test('cli build then verify round-trip succeeds', () => {
  const dir = tmpdir();
  const specPath = path.join(dir, 'spec.json');
  const reportPath = path.join(dir, 'report.json');
  fs.writeFileSync(specPath, JSON.stringify(maskedSpec()));
  const build = runCli(['build', specPath, reportPath], dir);
  assert.equal(build.status, 0);
  assert.match(build.stdout, /sha256:/);
  const verify = runCli(['verify', reportPath], dir);
  assert.equal(verify.status, 0);
  assert.match(verify.stdout, /verify ok/);
});

test('cli deny exits 1 with minimal set on stderr', () => {
  const dir = tmpdir();
  const spec = baseSpec();
  spec.grants.push({ role: 'base', unit: 'u2', effect: 'deny' });
  const specPath = path.join(dir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const res = runCli(['build', specPath, path.join(dir, 'report.json')], dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /E_DENY/);
  assert.match(res.stderr, /minimal over-privilege set: u2/);
});

test('cli verify rejects tampered report with exit 1', () => {
  const dir = tmpdir();
  const specPath = path.join(dir, 'spec.json');
  const reportPath = path.join(dir, 'report.json');
  fs.writeFileSync(specPath, JSON.stringify(baseSpec()));
  assert.equal(runCli(['build', specPath, reportPath], dir).status, 0);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.output.totals.revenue = 999;
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const res = runCli(['verify', reportPath], dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /E_HASH/);
});

test('cli mask version mismatch exits 1 with E_MASK', () => {
  const dir = tmpdir();
  const spec = maskedSpec();
  spec.request.masks = [{ rule: 'm1', version: 9 }];
  const specPath = path.join(dir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const res = runCli(['build', specPath, path.join(dir, 'report.json')], dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /E_MASK/);
});
