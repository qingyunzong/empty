'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cert-test-'));
}

function setup(dir, { lots, policy, tests }) {
  fs.writeFileSync(path.join(dir, 'lots.json'), JSON.stringify(lots, null, 2));
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy, null, 2));
  fs.writeFileSync(
    path.join(dir, 'tests.jsonl'),
    tests.map((t) => JSON.stringify(t)).join('\n') + '\n'
  );
}

function readCerts(dir) {
  const file = path.join(dir, 'cert.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function readTests(dir) {
  return fs.readFileSync(path.join(dir, 'tests.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const BASE_POLICY = {
  policyId: 'p',
  versions: [1, 2],
  rules: [
    { id: 'rel1', severity: 1, action: 'release', effectiveFrom: '2026-01-01T00:00:00Z', version: 1 },
    { id: 'hold2', severity: 2, action: 'hold', effectiveFrom: '2026-01-01T00:00:00Z', version: 1 },
    { id: 'rel2', severity: 2, action: 'release', effectiveFrom: '2026-03-01T00:00:00Z', version: 2 },
    { id: 'hold3', severity: 3, action: 'hold', effectiveFrom: '2026-01-01T00:00:00Z', version: 1 },
    { id: 'rec3', severity: 3, action: 'recall', effectiveFrom: '2026-04-01T00:00:00Z', version: 2 },
  ],
};

module.exports = { makeDir, setup, readCerts, readTests, runCli, BASE_POLICY };
