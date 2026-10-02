import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = new URL('../bin/mes-interlock.js', import.meta.url).pathname;

const POLICIES = {
  roles: { anyone: {}, operator: { inherits: ['anyone'] } },
  zones: { plant: {}, cellA: { inherits: ['plant'] } },
  subjects: { alice: { roles: ['operator'] } },
  devices: { press1: { zone: 'cellA' } },
  rules: [
    { id: 'r-open', effect: 'allow', action: 'openMold', role: 'operator', zone: 'cellA' },
    { id: 'r-heat-allow', effect: 'allow', action: 'heatUp', role: 'operator', zone: 'cellA' },
    { id: 'r-heat-deny', effect: 'deny', action: 'heatUp', role: 'operator', zone: 'cellA' },
  ],
};

function setup({ policies = POLICIES, requests } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mes-cli-'));
  const paths = {
    dir,
    policies: join(dir, 'policies.json'),
    requests: join(dir, 'requests.jsonl'),
    decisions: join(dir, 'decisions.jsonl'),
    audit: join(dir, 'audit.log'),
    stdout: join(dir, 'stdout.txt'),
    stderr: join(dir, 'stderr.txt'),
    code: join(dir, 'code.txt'),
  };
  writeFileSync(paths.policies, typeof policies === 'string' ? policies : JSON.stringify(policies));
  writeFileSync(paths.requests, requests);
  return paths;
}

// The sandbox swallows stdio of node processes spawned from node, so the
// child redirects its own streams to files which we read back.
function run(paths) {
  const cmd = [
    `node ${BIN}`,
    `--policies ${paths.policies}`,
    `--requests ${paths.requests}`,
    `--decisions ${paths.decisions}`,
    `--audit ${paths.audit}`,
    `> ${paths.stdout} 2> ${paths.stderr}`,
    `; echo $? > ${paths.code}`,
  ].join(' ');
  const res = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  assert.equal(res.status, 0, `bash wrapper failed: ${res.stderr}`);
  return {
    status: Number(readFileSync(paths.code, 'utf8').trim()),
    stdout: readFileSync(paths.stdout, 'utf8'),
    stderr: readFileSync(paths.stderr, 'utf8'),
  };
}

const REQUESTS = [
  { id: 'rq-1', subject: 'alice', device: 'press1', action: 'openMold', time: '2026-01-05T10:00:00Z' },
  { id: 'rq-2', subject: 'alice', device: 'press1', action: 'heatUp', time: '2026-01-05T10:00:00Z' },
].map((r) => JSON.stringify(r)).join('\n') + '\n';

test('CLI: happy path writes decisions.jsonl and audit.log', () => {
  const paths = setup({ requests: REQUESTS });
  const res = run(paths);
  assert.equal(res.status, 0, res.stderr);

  const lines = readFileSync(paths.decisions, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const [d1, d2] = lines.map((l) => JSON.parse(l));
  assert.equal(d1.decision, 'allow');
  assert.deepEqual(d1.winners, ['r-open']);
  assert.equal(d2.decision, 'deny');
  assert.equal(d2.reason, 'conflict-deny');
  assert.ok(d2.conflict);
  assert.ok(d1.counterexample.verifies);

  const audit = readFileSync(paths.audit, 'utf8');
  assert.match(audit, /id=rq-1 .* decision=allow/);
  assert.match(audit, /id=rq-2 .* decision=deny .* conflict=allow\[r-heat-allow\]deny\[r-heat-deny\]->deny/);
});

test('CLI: invalid policies JSON exits 2', () => {
  const paths = setup({ policies: '{ not json', requests: REQUESTS });
  const res = run(paths);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /invalid JSON/);
});

test('CLI: invalid requests line exits 2', () => {
  const paths = setup({ requests: '{"id":"x"\n' });
  const res = run(paths);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /line 1/);
});

test('CLI: unknown subject or device exits 3', () => {
  const bad = JSON.stringify({ subject: 'mallory', device: 'press1', action: 'openMold', time: '2026-01-05T10:00:00Z' }) + '\n';
  const res = run(setup({ requests: bad }));
  assert.equal(res.status, 3);
  assert.match(res.stderr, /unknown subject 'mallory'/);

  const badDevice = JSON.stringify({ subject: 'alice', device: 'press9', action: 'openMold', time: '2026-01-05T10:00:00Z' }) + '\n';
  const res2 = run(setup({ requests: badDevice }));
  assert.equal(res2.status, 3);
  assert.match(res2.stderr, /unknown device 'press9'/);
});

test('CLI: inheritance cycle exits 4 and lists the cycle', () => {
  const cyclic = {
    ...POLICIES,
    roles: { a: { inherits: ['b'] }, b: { inherits: ['c'] }, c: { inherits: ['a'] } },
    subjects: { alice: { roles: ['a'] } },
  };
  const res = run(setup({ policies: cyclic, requests: REQUESTS }));
  assert.equal(res.status, 4);
  assert.match(res.stderr, /role inheritance cycle/);
  assert.match(res.stderr, /a -> b -> c -> a/);
});

test('CLI: zone inheritance cycle exits 4', () => {
  const cyclic = {
    ...POLICIES,
    zones: { plant: { inherits: ['cellA'] }, cellA: { inherits: ['plant'] } },
  };
  const res = run(setup({ policies: cyclic, requests: REQUESTS }));
  assert.equal(res.status, 4);
  assert.match(res.stderr, /zone inheritance cycle/);
});
