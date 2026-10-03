import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../bin/cli.js';

const NOW = 1_000_000;
const FAR = String(NOW + 10_000_000);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-'));
}

// invoke the CLI in-process (sandbox forbids child processes), capturing output
function call(dir, args) {
  let out = '';
  let err = '';
  const code = run([...args, '--data', dir], { stdout: (s) => (out += s), stderr: (s) => (err += s) });
  return { code, out, err };
}

function callOk(dir, args) {
  const r = call(dir, args);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.err}`);
  return JSON.parse(r.out);
}

test('CLI end-to-end: issue/phrase/near/audit/revoke/sweep/purge/verify', () => {
  const dir = tmpdir();
  const root = callOk(dir, ['issue', '--id', 'R', '--exposure', '100', '--cap', '1000',
    '--terms', 'irrevocable standby letter of credit', '--expires', FAR, '--now', String(NOW)]);
  assert.equal(root.id, 'R');
  assert.match(root.hash, /^[0-9a-f]{64}$/);

  callOk(dir, ['issue', '--id', 'A', '--parent', 'R', '--exposure', '50', '--cap', '300',
    '--terms', 'standby credit payable on demand', '--expires', FAR, '--now', String(NOW)]);
  callOk(dir, ['issue', '--id', 'B', '--parent', 'R', '--exposure', '10', '--cap', '100',
    '--terms', 'short lived bond', '--expires', String(NOW + 500), '--now', String(NOW)]);

  const phrase = callOk(dir, ['phrase', 'standby credit']);
  assert.deepEqual(phrase, [{ id: 'A', positions: [0] }]);

  const near = callOk(dir, ['near', 'standby', 'demand', '--k', '4']);
  assert.deepEqual(near, [{ id: 'A', windows: [[0, 4]] }]);

  const audit = callOk(dir, ['audit', '--id', 'A', '--query', 'standby demand']);
  assert.deepEqual(audit.path.map((p) => p.id), ['R', 'A']);
  assert.deepEqual(audit.path.map((p) => p.remaining), [840, 250]);
  assert.deepEqual(audit.hits, { standby: [0], demand: [4] });
  assert.equal(audit.chainHash, audit.path.at(-1).hash);
  assert.equal(audit.valid, true);

  // over-limit via CLI exits 1 with structured error
  const over = call(dir, ['issue', '--id', 'X', '--parent', 'A', '--exposure', '251', '--cap', '999',
    '--terms', 'x', '--expires', FAR, '--now', String(NOW)]);
  assert.equal(over.code, 1);
  assert.equal(JSON.parse(over.err).error, 'OVER_LIMIT');

  // sweep expires B; purging active R must fail; purging dead leaf B succeeds
  const swept = callOk(dir, ['sweep', '--now', String(NOW + 500)]);
  assert.deepEqual(swept.expired, ['B']);
  const purgeRoot = call(dir, ['purge', '--id', 'R']);
  assert.equal(purgeRoot.code, 1);
  assert.equal(JSON.parse(purgeRoot.err).error, 'NOT_PURGEABLE');
  const purged = callOk(dir, ['purge', '--id', 'B']);
  assert.deepEqual(purged.purged, ['B']);

  // double revoke via CLI fails
  callOk(dir, ['revoke', '--id', 'A', '--now', String(NOW + 600)]);
  const twice = call(dir, ['revoke', '--id', 'A', '--now', String(NOW + 601)]);
  assert.equal(twice.code, 1);
  assert.equal(JSON.parse(twice.err).error, 'ALREADY_REVOKED');

  // every CLI call reloads from disk (fresh process equivalent): verify restart state
  const verify = callOk(dir, ['verify']);
  assert.deepEqual(verify, { ok: true, problems: [] });
  const show = callOk(dir, ['show', '--id', 'R']);
  assert.equal(show.used, 100);
  assert.equal(show.remaining, 900);
});
