// CLI end-to-end, exercised in-process through the exported run() entry
// (the sandboxed environment swallows stdout of nested node processes, so
// the CLI is written to accept an injected writer and is tested directly).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../cli.js';
import { pair, ev } from './helpers.js';

function runCli(args) {
  let out = '';
  const code = run(args, { write: (s) => { out += s; } });
  return { code, json: JSON.parse(out) };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'recon-'));
  const write = (name, events) => {
    const p = join(dir, name);
    writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n'));
    return p;
  };
  return { dir, write };
}

test('CLI diff: balanced pair exits 0', () => {
  const { write } = fixture();
  const left = write('left.jsonl', pair('l1', 'l2', { relId: 'r1' }));
  const right = write('right.jsonl', pair('r1', 'r2', { relId: 'r1' }));
  const { code, json } = runCli(['diff', left, right, '--k', '5']);
  assert.equal(code, 0);
  assert.equal(json.balanced, true);
  assert.deepEqual(json.scripts, []);
});

test('CLI diff: extra entries exit 1 with removeExtra scripts', () => {
  const { write } = fixture();
  const left = write('left.jsonl', [...pair('l1', 'l2', { relId: 'r1' }), ev('lx', 'cash', 9, 'debit', 'USD', 'rx')]);
  const right = write('right.jsonl', pair('r1', 'r2', { relId: 'r1' }));
  const { code, json } = runCli(['diff', left, right, '--k', '5']);
  assert.equal(code, 1);
  assert.equal(json.balanced, false);
  assert.equal(json.minCost, 1);
  assert.ok(json.scripts.some((s) => s[0].op === 'removeExtra'));
  assert.equal(json.certificate.reason, 'UNMATCHED_EVENTS');
});

test('CLI diff: over-bound case exits 2 with SEARCH_BOUND and a verifiable certificate', () => {
  const { write } = fixture();
  const leftEvents = [...pair('l1', 'l2', { relId: 't1' })];
  for (let i = 0; i < 3; i += 1) leftEvents.push(...pair(`x${i}a`, `x${i}b`, { relId: `e${i}`, amount: i + 1 }));
  const left = write('left.jsonl', leftEvents);
  const right = write('right.jsonl', pair('r1', 'r2', { relId: 't1' }));
  const { code, json } = runCli(['diff', left, right, '--k', '5']);
  assert.equal(code, 2);
  assert.equal(json.balanced, false);
  assert.equal(json.error.code, 'SEARCH_BOUND');
  assert.ok(json.certificate.provenLowerBound >= 6);
  // Round-trip: the emitted certificate verifies via the CLI.
  const certPath = join(mkdtempSync(join(tmpdir(), 'recon-cert-')), 'cert.json');
  writeFileSync(certPath, JSON.stringify(json.certificate));
  const v = runCli(['verify', left, right, certPath]);
  assert.equal(v.code, 0);
  assert.equal(v.json.valid, true);
});

test('CLI diff: DUP_ID surfaces as an error code', () => {
  const { write } = fixture();
  const left = write('left.jsonl', [ev('a', 'cash', 1, 'debit', 'USD', 'r1'), ev('a', 'cash', 1, 'credit', 'USD', 'r1')]);
  const right = write('right.jsonl', []);
  const { code, json } = runCli(['diff', left, right]);
  assert.equal(code, 2);
  assert.equal(json.error.code, 'DUP_ID');
});

test('CLI verify: tampered certificate exits 2 with CERT_INVALID', () => {
  const { write } = fixture();
  const left = write('left.jsonl', [...pair('l1', 'l2', { relId: 'r1' }), ev('lx', 'cash', 9, 'debit', 'USD', 'rx')]);
  const right = write('right.jsonl', pair('r1', 'r2', { relId: 'r1' }));
  const diff = runCli(['diff', left, right, '--k', '5']);
  const certPath = join(mkdtempSync(join(tmpdir(), 'recon-cert-')), 'cert.json');
  writeFileSync(certPath, JSON.stringify({ ...diff.json.certificate, provenLowerBound: 99 }));
  const v = runCli(['verify', left, right, certPath]);
  assert.equal(v.code, 2);
  assert.equal(v.json.error.code, 'CERT_INVALID');
});

