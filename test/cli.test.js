import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// The sandbox swallows grandchild stdio pipes, so capture via files.
function run(dir, args) {
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, '.stdout');
  const errFile = path.join(dir, '.stderr');
  const codeFile = path.join(dir, '.exitcode');
  const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  const quoted = [CLI, ...args, '--dir', dir].map(quote).join(' ');
  const cmd = `${quote(process.execPath)} ${quoted} >${quote(outFile)} 2>${quote(errFile)}; echo $? >${quote(codeFile)}`;
  spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  return {
    status: Number(fs.readFileSync(codeFile, 'utf8').trim()),
    stdout: fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '',
    stderr: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '',
  };
}

test('CLI end-to-end: add, phrase, near, pair, revoke, delete, compact', () => {
  const dir = tmpdir();
  let r = run(dir, ['add', '--id', 'T1', '--buyer', 'A', '--seller', 'B', '--amount', '100', '--desc', 'quick brown fox']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).settlement.direction.payer, 'A');

  r = run(dir, ['add', '--id', 'T2', '--buyer', 'B', '--seller', 'A', '--amount', '250', '--desc', 'quick brown dog']);
  assert.strictEqual(r.status, 0, r.stderr);
  const cert = JSON.parse(r.stdout).settlement;
  assert.strictEqual(cert.reversed, true);
  assert.strictEqual(cert.direction.payer, 'B');
  assert.deepStrictEqual(cert.batch.map((o) => o.op), ['release', 'freeze']);

  r = run(dir, ['phrase', 'quick brown']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout).hits.map((h) => h.id), ['T1', 'T2']);

  r = run(dir, ['near', 'quick fox', '--k', '3']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).best, 'T1');

  r = run(dir, ['pair', '--a', 'A', '--b', 'B']);
  assert.strictEqual(JSON.parse(r.stdout).net, 150);

  r = run(dir, ['revoke', '--id', 'T2']);
  assert.strictEqual(JSON.parse(r.stdout).direction.payer, 'A');

  r = run(dir, ['delete', '--id', 'T1']);
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(dir, ['phrase', 'quick brown']);
  assert.deepStrictEqual(
    JSON.parse(r.stdout).hits.map((h) => h.id),
    ['T2'],
    'deleted trade leaves phrase results',
  );

  r = run(dir, ['compact']);
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(dir, ['segments']);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('CLI errors exit non-zero with error code and persist nothing', () => {
  const dir = tmpdir();
  let r = run(dir, ['add', '--id', 'T1', '--buyer', 'A', '--seller', 'B', '--amount=-3']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /NEGATIVE_AMOUNT/);

  r = run(dir, ['revoke', '--id', 'GHOST']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /UNKNOWN_TRADE/);

  r = run(dir, ['add', '--id', 'T1', '--buyer', 'A', '--seller', 'B', '--amount', '10']);
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(dir, ['delete', '--id', 'T1']);
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(dir, ['delete', '--id', 'T1']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /DUPLICATE_DELETE/);
});
