import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-'));
  const script = path.join(dir, 'script.qta');
  const events = path.join(dir, 'events.jsonl');
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(script, `
customer C0001;
note /^[A-Z0-9-]{3,32}$/;
bucket b { limit 1000; }
approval L1 { cap b 900; approval L2 { cap b 500; } }
`);
  fs.writeFileSync(events, [
    JSON.stringify({ type: 'freeze', id: 'F1', ts: '2026-10-01T09:00:00Z', customer: 'C0001', bucket: 'b', amount: 400, until: '2026-12-31', note: 'REQ-1', scope: ['L1', 'L2'] }),
    JSON.stringify({ type: 'debit', id: 'D1', ts: '2026-10-02T09:00:00Z', customer: 'C0001', bucket: 'b', amount: 100, note: 'REQ-2', freeze_id: 'F1' }),
    JSON.stringify({ type: 'business_day', id: 'BD1', date: '2027-01-01' }),
  ].join('\n') + '\n');
  return { dir, script, events, state };
}

// Run the CLI entry point in-process (the sandbox forbids child processes),
// capturing stdout/stderr.
function runCli(argv) {
  const out = [];
  const err = [];
  const olog = console.log;
  const oerr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = main(argv);
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = olog;
    console.error = oerr;
  }
}

test('CLI: apply writes state.json, replay confirms it', () => {
  const { script, events, state } = setup();
  const applied = runCli(['apply', script, events, '--out', state]);
  assert.equal(applied.code, 0);
  assert.match(applied.stdout, /3 ok, 0 rejected/);
  assert.match(applied.stdout, /bucket b: available=900 frozen=0 used=100/);
  const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(saved.log.length, 3);
  assert.equal(saved.final.buckets.b.used, 100);
  const replayed = runCli(['replay', state]);
  assert.equal(replayed.code, 0);
  assert.match(replayed.stdout, /REPLAY OK/);
});

test('CLI: compile-time E_SCOPE exits non-zero with the error code', () => {
  const { dir, events, state } = setup();
  const bad = path.join(dir, 'bad.qta');
  fs.writeFileSync(bad, `
customer C0001;
bucket b { limit 1000; }
approval L1 { cap b 100; approval L2 { cap b 200; } }
`);
  const res = runCli(['apply', bad, events, '--out', state]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /E_SCOPE/);
});
