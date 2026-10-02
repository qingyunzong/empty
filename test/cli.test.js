'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../lib/cli');
const { canonical, sha256, GENESIS } = require('../lib/index');

const POLICY = [
  { type: 'inherit', role: 'auditor', inherits: 'analyst' },
  { type: 'inherit', role: 'analyst', inherits: 'viewer' },
  { type: 'rule', id: 'r-read', role: 'viewer', resource: 'settlement:read', effect: 'allow' },
  { type: 'rule', id: 'r-no-export', role: 'viewer', resource: 'settlement:export', effect: 'deny' },
  { type: 'rule', id: 'r-export', role: 'analyst', resource: 'settlement:export', effect: 'allow' },
  { type: 'revoke', role: 'viewer', at: 100 },
].map((r) => JSON.stringify(r)).join('\n');

const EVENTS = [
  { type: 'authorize', id: 'e1', role: 'auditor', resource: 'settlement:read', ts: 50 },
  { type: 'authorize', id: 'e2', role: 'auditor', resource: 'settlement:read', ts: 150 },
  { type: 'authorize', id: 'e3', role: 'auditor', resource: 'settlement:export', ts: 50 },
].map((r) => JSON.stringify(r)).join('\n');

function capture() {
  const io = { stdout: '', stderr: '' };
  const sinks = {
    stdout: (s) => { io.stdout += s; },
    stderr: (s) => { io.stderr += s; },
  };
  return { io, sinks };
}

function makeWorkspace(t, policyText, eventsText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const policyPath = path.join(dir, 'policy.jsonl');
  const eventsPath = path.join(dir, 'events.jsonl');
  const outDir = path.join(dir, 'out');
  fs.writeFileSync(policyPath, policyText);
  fs.writeFileSync(eventsPath, eventsText);
  return { policyPath, eventsPath, outDir };
}

test('CLI writes decisions.jsonl and audit.json with a verifiable hash chain', (t) => {
  const { policyPath, eventsPath, outDir } = makeWorkspace(t, `${POLICY}\n`, `${EVENTS}\n`);
  const { io, sinks } = capture();
  const code = runCli([policyPath, eventsPath, outDir], sinks);
  assert.equal(code, 0);
  assert.match(io.stdout, /wrote 3 decisions/);

  const decisions = fs
    .readFileSync(path.join(outDir, 'decisions.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const audit = JSON.parse(fs.readFileSync(path.join(outDir, 'audit.json'), 'utf8'));

  assert.equal(decisions.length, 3);

  // e1: before revocation -> allow via inherited viewer rule
  assert.equal(decisions[0].decision, 'allow');
  assert.deepEqual(decisions[0].path, ['auditor', 'analyst', 'viewer']);
  // e2: after revocation of viewer -> default deny
  assert.equal(decisions[1].decision, 'deny');
  assert.equal(decisions[1].reason, 'DEFAULT_DENY');
  // e3: explicit deny on viewer beats allow on analyst
  assert.equal(decisions[2].decision, 'deny');
  assert.equal(decisions[2].reason, 'DENY_OVERRIDES_ALLOW');
  assert.equal(decisions[2].rule, 'r-no-export');

  // recompute the hash chain independently
  let head = GENESIS;
  for (const d of decisions) {
    const { hash, ...payload } = d;
    head = sha256(`${head}\n${canonical(payload)}`);
    assert.equal(hash, head);
  }
  assert.equal(audit.root, head);
  assert.equal(audit.decisions, 3);
  assert.equal(audit.allows, 1);
  assert.equal(audit.denies, 2);
  assert.equal(audit.policyHash, sha256(`${POLICY}\n`));
  assert.equal(audit.eventsHash, sha256(`${EVENTS}\n`));
});

test('CLI exits 1 and reports {error:{code,line}} on stderr for E_CYCLE', (t) => {
  const { policyPath, eventsPath, outDir } = makeWorkspace(
    t,
    '{"type":"inherit","role":"a","inherits":"b"}\n{"type":"inherit","role":"b","inherits":"a"}\n',
    '',
  );
  const { io, sinks } = capture();
  const code = runCli([policyPath, eventsPath, outDir], sinks);
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(io.stderr.trim()), { error: { code: 'E_CYCLE', line: 2 } });
});

test('CLI reports E_PARSE for malformed events line', (t) => {
  const { policyPath, eventsPath, outDir } = makeWorkspace(
    t,
    '{"type":"role","role":"a"}\n',
    '{"type":"authorize","id":"e1","role":"a","resource":"r","ts":1}\noops\n',
  );
  const { io, sinks } = capture();
  const code = runCli([policyPath, eventsPath, outDir], sinks);
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(io.stderr.trim()), { error: { code: 'E_PARSE', line: 2 } });
});

test('CLI reports E_SCHEMA for invalid event records', (t) => {
  const { policyPath, eventsPath, outDir } = makeWorkspace(
    t,
    '{"type":"role","role":"a"}\n',
    '{"type":"authorize","id":"e1","role":"a"}\n',
  );
  const { io, sinks } = capture();
  const code = runCli([policyPath, eventsPath, outDir], sinks);
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(io.stderr.trim()), { error: { code: 'E_SCHEMA', line: 1 } });
});

test('CLI exits 2 on missing arguments', () => {
  const { io, sinks } = capture();
  const code = runCli(['only-policy.jsonl'], sinks);
  assert.equal(code, 2);
  assert.match(io.stderr, /usage:/);
});
