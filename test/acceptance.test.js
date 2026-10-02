'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPolicy } = require('../src/model');
const { visibilityBitmap, referenceBitmap } = require('../src/evaluate');
const { run } = require('../src/cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
}

function write(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

// In-process CLI invocation (child_process is intentionally avoided).
function runCli(args) {
  let stdout = '';
  let stderr = '';
  const status = run(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { status, stdout, stderr };
}

function acceptancePolicy(extra = {}) {
  return {
    tenants: {
      root: {},
      'group-east': { parent: 'root' },
      'group-west': { parent: 'root' },
      'tenant-a': { parent: 'group-east' },
      'tenant-b': { parent: 'group-west' },
    },
    tags: ['line-1', 'safety-public'],
    devices: { 'press-1': { tags: ['line-1'] } },
    grants: [
      { id: 'g1', tenant: 'group-east', tag: 'line-1', actions: ['read', 'modify', 'mark_false_positive'] },
    ],
    denies: [],
    exceptions: [],
    revocations: [],
    ...extra,
  };
}

const EVENTS = [
  { id: 'e1', ts: 100, device: 'press-1', type: 'fault' },
  { id: 'e2', ts: 120, device: 'press-1', type: 'fault' },
];

test('A: cross-tenant visibility on the same device', () => {
  const dir = tmpdir();
  const policy = write(dir, 'policy.json', JSON.stringify(acceptancePolicy()));
  const events = write(dir, 'events.jsonl', EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const ra = runCli(['query', '--policy', policy, '--events', events, '--tenant', 'tenant-a', '--at', '200']);
  assert.equal(ra.status, 0, ra.stderr);
  const linesA = ra.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(linesA.map((l) => l.bitmap), [7, 7]); // group grant inherited

  const rb = runCli(['query', '--policy', policy, '--events', events, '--tenant', 'tenant-b', '--at', '200']);
  assert.equal(rb.status, 0, rb.stderr);
  const linesB = rb.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(linesB.map((l) => l.bitmap), [0, 0]); // other tenant sees nothing
});

test('B: revocation changes detail query results; derived stats stay frozen; audit explains', () => {
  const dir = tmpdir();
  const policy = write(
    dir,
    'policy.json',
    JSON.stringify(acceptancePolicy({ revocations: [{ id: 'r1', grant: 'g1', tenant: 'tenant-a', ts: 1000 }] }))
  );
  const events = write(dir, 'events.jsonl', EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const audit = path.join(dir, 'audit.jsonl');
  const store = path.join(dir, 'stats.json');

  // Same query before the revocation ts and after it.
  const before = runCli(['query', '--policy', policy, '--events', events, '--tenant', 'tenant-a', '--at', '500']);
  const after = runCli([
    'query', '--policy', policy, '--events', events, '--tenant', 'tenant-a', '--at', '1500', '--audit', audit,
  ]);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(before.stdout.trim().split('\n').map((l) => JSON.parse(l).bitmap), [7, 7]);
  assert.deepEqual(after.stdout.trim().split('\n').map((l) => JSON.parse(l).bitmap), [0, 0]);

  // Audit explains the denial with a minimal counterexample naming the revocation.
  const records = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
  const deniedRead = records.find((r) => r.type === 'decision' && r.event === 'e1' && r.action === 'read');
  assert.equal(deniedRead.allow, false);
  assert.equal(deniedRead.counterexample.kind, 'extra-revocation');
  assert.equal(deniedRead.counterexample.revocation, 'r1');

  // Stats derived at t=500 stay frozen even when recomputed after revocation.
  const s1 = runCli(['stats', '--policy', policy, '--events', events, '--tenant', 'tenant-a', '--at', '500', '--store', store]);
  assert.equal(s1.status, 0, s1.stderr);
  const snap1 = JSON.parse(s1.stdout);
  assert.deepEqual(snap1.counts, { read: 2, modify: 2, mark_false_positive: 2 });
  assert.equal(snap1.snapshot, false);

  const s2 = runCli(['stats', '--policy', policy, '--events', events, '--tenant', 'tenant-a', '--at', '1500', '--store', store]);
  const snap2 = JSON.parse(s2.stdout);
  assert.equal(snap2.snapshot, true);
  assert.deepEqual(snap2.counts, snap1.counts); // unchanged despite revocation
  assert.equal(snap2.computedAt, 500);
});

test('C: false-positive marking stays consistent with the original event', () => {
  const dir = tmpdir();
  const policy = write(dir, 'policy.json', JSON.stringify(acceptancePolicy()));
  const eventsWithMarks = [
    ...EVENTS,
    { id: 'm1', ts: 130, type: 'mark_false_positive', target: 'e1', tenant: 'tenant-a' }, // authorized
    { id: 'm2', ts: 140, type: 'mark_false_positive', target: 'e2', tenant: 'tenant-b' }, // unauthorized
    { id: 'm3', ts: 150, type: 'mark_false_positive', target: 'ghost', tenant: 'tenant-a' }, // unknown target
  ];
  const events = write(dir, 'events.jsonl', eventsWithMarks.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const audit = path.join(dir, 'audit.jsonl');

  const r = runCli(['query', '--policy', policy, '--events', events, '--tenant', 'tenant-a', '--at', '200', '--audit', audit]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map(JSON.parse);
  const byId = Object.fromEntries(lines.map((l) => [l.event, l]));

  // Authorized marking applied to the original event, with matching attributes.
  assert.deepEqual(byId.e1.falsePositive, { by: 'tenant-a', at: 130, markingEvent: 'm1' });
  assert.equal(byId.m1.markingStatus, 'applied');
  // Unauthorized marking rejected; original event unchanged.
  assert.equal(byId.e2.falsePositive, undefined);
  assert.equal(byId.m2.markingStatus, 'rejected');
  // Marking of unknown target rejected.
  assert.equal(byId.m3.markingStatus, 'rejected');

  const records = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
  const m2rec = records.find((x) => x.type === 'marking' && x.event === 'm2');
  assert.equal(m2rec.applied, false);
  assert.match(m2rec.reason, /missing grant/);
});

test('D: <=12 subjects/tags enumeration matches reference decisions', () => {
  // Deterministic PRNG for reproducible policy generation.
  let seed = 42;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const tenants = { root: {} };
  const tenantNames = ['root'];
  for (let i = 0; i < 11; i++) {
    const name = `t${i}`;
    tenants[name] = rand() < 0.6 ? { parent: pick(tenantNames) } : {};
    tenantNames.push(name);
  }
  const tags = Array.from({ length: 12 }, (_, i) => `tag${i}`);
  const devices = {};
  for (let i = 0; i < 6; i++) {
    const n = 1 + Math.floor(rand() * 3);
    const dt = new Set();
    while (dt.size < n) dt.add(pick(tags));
    devices[`dev${i}`] = { tags: [...dt] };
  }
  const ACTIONS = ['read', 'modify', 'mark_false_positive'];
  const someActions = () => {
    const picked = ACTIONS.filter(() => rand() < 0.6);
    return picked.length > 0 ? picked : ['read'];
  };

  const grants = [];
  for (let i = 0; i < 15; i++) {
    grants.push({ id: `g${i}`, tenant: pick(tenantNames), tag: pick(tags), actions: someActions() });
  }
  const denies = [];
  for (let i = 0; i < 8; i++) {
    denies.push({ id: `d${i}`, tenant: pick(tenantNames), tag: pick(tags), actions: someActions() });
  }
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push({
      id: `e${i}`,
      ts: 100 + i * 10,
      device: pick(Object.keys(devices)),
      type: i % 4 === 0 ? 'shutdown' : 'fault',
    });
  }
  const exceptions = [];
  for (let i = 0; i < 10; i++) {
    exceptions.push({
      id: `x${i}`,
      event: pick(events).id,
      tenant: pick(tenantNames),
      action: pick(ACTIONS),
      effect: rand() < 0.5 ? 'allow' : 'deny',
    });
  }
  const revocations = [];
  for (let i = 0; i < 6; i++) {
    revocations.push({
      id: `r${i}`,
      grant: pick(grants).id,
      tenant: rand() < 0.5 ? pick(tenantNames) : undefined,
      ts: Math.floor(rand() * 2000),
    });
  }

  const policy = loadPolicy({ tenants, tags, devices, grants, denies, exceptions, revocations });
  assert.ok(tenantNames.length <= 12 && tags.length <= 12);

  let comparisons = 0;
  for (const at of [0, 500, 1000, 2000]) {
    for (const tenant of tenantNames) {
      for (const event of events) {
        const main = visibilityBitmap(policy, tenant, event, at).bitmap;
        const ref = referenceBitmap(policy, tenant, event, at);
        assert.equal(main, ref, `bitmap mismatch tenant=${tenant} event=${event.id} at=${at}`);
        comparisons++;
      }
    }
  }
  assert.ok(comparisons > 0);
});

test('CLI exit codes: 4 tenant cycle, 8 out-of-order, 9 unknown tag', () => {
  const dir = tmpdir();
  const events = write(dir, 'events.jsonl', '{"id":"e1","ts":1}\n');

  const cycle = write(dir, 'cycle.json', JSON.stringify({ tenants: { a: { parent: 'b' }, b: { parent: 'a' } }, tags: [] }));
  assert.equal(runCli(['query', '--policy', cycle, '--events', events, '--tenant', 'a']).status, 4);

  const badTag = write(
    dir,
    'badtag.json',
    JSON.stringify({ tenants: { a: {} }, tags: [], grants: [{ id: 'g', tenant: 'a', tag: 'ghost', actions: ['read'] }] })
  );
  assert.equal(runCli(['query', '--policy', badTag, '--events', events, '--tenant', 'a']).status, 9);

  const okPolicy = write(dir, 'ok.json', JSON.stringify({ tenants: { a: {} }, tags: [] }));
  const ooo = write(dir, 'ooo.jsonl', '{"id":"e1","ts":1000}\n{"id":"e2","ts":10}\n');
  assert.equal(runCli(['query', '--policy', okPolicy, '--events', ooo, '--tenant', 'a', '--window', '100']).status, 8);
});
