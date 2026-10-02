import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../cli.js';

const CLI = new URL('../cli.js', import.meta.url).pathname;

function fixture(text) {
  const dir = mkdtempSync(join(tmpdir(), 'exp-dsl-'));
  const file = join(dir, 'case.dsl');
  writeFileSync(file, text);
  return file;
}

// In-process invocation with captured output (sandboxed environments may
// not propagate child-process stdio pipes).
function invoke(args) {
  let stdout = '';
  let stderr = '';
  const code = run(args, { out: (s) => (stdout += s), err: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

test('parse command prints snapshot and visible bindings', () => {
  const file = fixture('experiment e { let a = 1 + 2 * 3; }');
  const res = invoke(['parse', file, '--scope', 'e']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.parentVersion, null);
  assert.equal(out.visible.a.value, 7);
  assert.equal(out.visible.a.definedIn, 'root.e');
});

test('resolve command prints value and full scope chain', () => {
  const file = fixture(`
    experiment outer {
      let rate = 1;
      experiment mid {
        let rate = 2;
        experiment inner { let rate = 3; }
      }
    }
  `);
  const res = invoke(['resolve', file, 'rate', '--scope', 'outer.mid.inner']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.value, 3);
  assert.equal(out.definedIn, 'root.outer.mid.inner');
  assert.deepEqual(out.chain.map((c) => c.scope), ['inner', 'mid', 'outer', 'root']);
});

test('correct command yields coexisting parent and child versions', () => {
  const file = fixture('let a = 1; let b = a + 1;');
  const res = invoke(['correct', file, 'a', '10']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.parentVersion < out.version, true);
  assert.equal(out.corrected.value, 10);
  assert.deepEqual(
    Object.fromEntries(Object.entries(out.visible).map(([k, v]) => [k, v.value])),
    { a: 10, b: 11 },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(out.parentVisible).map(([k, v]) => [k, v.value])),
    { a: 1, b: 2 },
  );
});

test('errors return exit code 1', () => {
  const unknownName = fixture('let a = ghost + 1;');
  const badOverride = fixture('experiment e { override nope = 1; }');
  const unterminated = fixture('let a = `unterminated;');
  const ok = fixture('let a = 1;');

  assert.equal(invoke(['resolve', unknownName, 'a']).code, 1);
  assert.equal(invoke(['parse', badOverride]).code, 1);
  const res = invoke(['parse', unterminated]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unterminated raw observation/);
  assert.equal(invoke(['correct', ok, 'missing', '2']).code, 1);
});

test('real process exits with code 1 on error and 0 on success', () => {
  const bad = fixture('let a = `unterminated;');
  const good = fixture('let a = 1;');
  assert.equal(spawnSync(process.execPath, [CLI, 'parse', bad]).status, 1);
  assert.equal(spawnSync(process.execPath, [CLI, 'parse', good]).status, 0);
});
