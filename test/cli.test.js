'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-cli-'));
}

function runCli(input, output) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let status;
  try {
    status = main(['node', 'cli.js', input, output]);
  } finally {
    console.error = original;
  }
  return { status, stderr: errors.join('\n') };
}

const SCENARIO = [
  { type: 'add_dept', dept: 'root' },
  { type: 'add_dept', dept: 'trade', parents: ['root'] },
  { type: 'add_dept', dept: 'trade-asia', parents: ['trade'] },
  { type: 'add_member', member: 'alice', dept: 'trade-asia' },
  { type: 'add_member', member: 'bob', dept: 'trade' },
  { type: 'add_member', member: 'dave', dept: 'trade-asia' },
  { type: 'add_member', member: 'comply', dept: 'root', role: 'compliance' },
  { type: 'submit', request: 'R1', submitter: 'alice', dept: 'trade-asia', amount: 50000 },
  { type: 'freeze', request: 'R1', by: 'comply' },
  { type: 'approve', request: 'R1', approver: 'bob', decision: 'allow', ts: 100 },
  { type: 'approve', request: 'R1', approver: 'dave', decision: 'allow', ts: 101 },
  { type: 'unfreeze', request: 'R1', by: 'comply' },
  { type: 'revoke', request: 'R1', approver: 'bob', by: 'bob' },
];

test('cli: processes JSONL scenario and writes final.json', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'events.jsonl');
  const output = path.join(dir, 'final.json');
  fs.writeFileSync(input, SCENARIO.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const result = runCli(input, output);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /E_FINAL/);
  const final = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(final.requests.R1.state, 'DISBURSED');
  assert.equal(final.requests.R1.frozen, false);
  assert.equal(final.requests.R1.approvals.length, 2);
  assert.match(final.auditHash, /^[0-9a-f]{64}$/);
  const revokeTransition = final.transitions.find((t) => t.event.type === 'revoke');
  assert.equal(revokeTransition.ok, false);
  assert.equal(revokeTransition.error, 'E_FINAL');
  const unfreeze = final.transitions.find((t) => t.event.type === 'unfreeze');
  assert.deepEqual(unfreeze.activated, ['bob', 'dave']);
  assert.equal(unfreeze.to, 'DISBURSED');
});

test('cli: malformed JSON line exits 1 with E_PARSE on stderr', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'events.jsonl');
  const output = path.join(dir, 'final.json');
  fs.writeFileSync(input, '{"type":"add_dept","dept":"root"}\nnot json\n');
  const result = runCli(input, output);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_PARSE/);
  assert.equal(fs.existsSync(output), false);
});

test('cli: structural error (unknown request) exits 1', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'events.jsonl');
  const output = path.join(dir, 'final.json');
  fs.writeFileSync(input, '{"type":"approve","request":"NOPE","approver":"x","decision":"allow"}\n');
  const result = runCli(input, output);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_UNKNOWN_REQUEST/);
});

test('cli: missing input file exits 1 with E_IO', () => {
  const dir = tmpdir();
  const result = runCli(path.join(dir, 'nope.jsonl'), path.join(dir, 'o.json'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_IO/);
});

test('cli: missing usage args exits 1', () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let status;
  try {
    status = main(['node', 'cli.js']);
  } finally {
    console.error = original;
  }
  assert.equal(status, 1);
  assert.match(errors.join('\n'), /usage/);
});

test('cli: output is deterministic across runs', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'events.jsonl');
  fs.writeFileSync(input, SCENARIO.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const out1 = path.join(dir, 'f1.json');
  const out2 = path.join(dir, 'f2.json');
  assert.equal(runCli(input, out1).status, 0);
  assert.equal(runCli(input, out2).status, 0);
  assert.equal(fs.readFileSync(out1, 'utf8'), fs.readFileSync(out2, 'utf8'));
});
