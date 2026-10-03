import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';

function run(dir, args) {
  let out = '';
  const code = runCli(['--data', dir, ...args], (s) => { out += s; }, () => {});
  return { code, json: out ? JSON.parse(out) : null };
}

test('CLI: deposit/freeze/search/cancel/verify round-trip with rev conflicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hold-cli-'));

  let r = run(dir, ['deposit', '--wallet', 'alice', '--amount', '500', '--rev', '0']);
  assert.equal(r.code, 0);
  assert.equal(r.json.balance, 500);

  r = run(dir, ['freeze', '--wallet', 'alice', '--amount', '120', '--memo', 'rent for october office', '--rev', '1']);
  assert.equal(r.code, 0);
  assert.equal(r.json.held, 120);
  const { cert } = r.json;

  // stale rev -> exit 2, carries current rev + cert
  r = run(dir, ['freeze', '--wallet', 'alice', '--amount', '10', '--memo', 'stale', '--rev', '1']);
  assert.equal(r.code, 2);
  assert.equal(r.json.error, 'CONFLICT');
  assert.equal(r.json.currentRev, 2);
  assert.equal(r.json.cert, cert);

  r = run(dir, ['freeze', '--wallet', 'alice', '--amount', '50', '--memo', 'office snacks budget', '--rev', '2']);
  assert.equal(r.code, 0);

  // proximity: "office snacks" adjacent
  r = run(dir, ['search', '--query', 'office snacks']);
  assert.deepEqual(r.json.matches.map((m) => m.id), ['h2']);

  // cancel h2 -> hidden by default, visible with --include-history and annotated
  r = run(dir, ['cancel', '--id', 'h2', '--rev', '3']);
  assert.equal(r.code, 0);
  r = run(dir, ['search', '--query', 'office snacks']);
  assert.equal(r.json.matches.length, 0);
  r = run(dir, ['search', '--query', 'office snacks', '--include-history']);
  assert.equal(r.json.matches.length, 1);
  assert.equal(r.json.matches[0].state, 'cancelled');
  assert.equal(r.json.matches[0].deleted, true);

  r = run(dir, ['balance', '--wallet', 'alice']);
  assert.equal(r.json.balance, 380);
  assert.equal(r.json.held, 120);

  r = run(dir, ['verify']);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
});
