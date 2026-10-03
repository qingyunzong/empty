import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

test('CLI issues, queries, audits and verifies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guarantee-cli-'));
  const base = ['--data', dir];
  const ok = (args) => {
    const result = run(args);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const root = ok([...base, 'issue', '--id', 'R', '--exposure', '10', '--cap', '100',
    '--terms', 'master standby letter of credit', '--expires-at', '2030-01-01T00:00:00Z']);
  assert.equal(root.state, 'ACTIVE');

  ok([...base, 'issue', '--id', 'C1', '--parent', 'R', '--exposure', '40', '--cap', '50',
    '--terms', 'child advance payment guarantee', '--expires-at', '2030-01-01T00:00:00Z']);

  const shown = ok([...base, 'show', '--id', 'R']);
  assert.equal(shown.used, 40);
  assert.equal(shown.cap - shown.used, 60);

  assert.deepEqual(ok([...base, 'phrase', 'advance payment']), { C1: [1] });
  assert.deepEqual(ok([...base, 'near', 'standby', 'credit', '--k', '3']), { R: [[1, 4]] });

  const audit = ok([...base, 'audit', '--id', 'C1', '--phrase', 'payment guarantee']);
  assert.deepEqual(audit.path.map((l) => l.id), ['R', 'C1']);
  assert.deepEqual(audit.path.map((l) => l.remaining), [60, 50]);
  assert.deepEqual(audit.hits.phrase, [2]);
  assert.ok(audit.verified);

  assert.deepEqual(ok([...base, 'verify']), { ok: true, problems: [] });

  assert.equal(ok([...base, 'revoke', '--id', 'C1']).state, 'REVOKED');
  assert.equal(ok([...base, 'show', '--id', 'R']).used, 0);

  const dup = run([...base, 'revoke', '--id', 'C1']);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /INVALID_STATE/);

  const over = run([...base, 'issue', '--id', 'BIG', '--parent', 'R', '--exposure', '500',
    '--cap', '1', '--expires-at', '2030-01-01T00:00:00Z']);
  assert.equal(over.code, 1);
  assert.match(over.stderr, /OVER_CAP/);
  assert.equal(ok([...base, 'show', '--id', 'R']).used, 0);
});
