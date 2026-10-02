import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// Note: this sandbox cannot pipe child stdio, so the request/response are
// passed through temp files wired to the child's stdin/stdout fds. The CLI
// itself still reads stdin and writes stdout exclusively.
function runCli(request) {
  const dir = mkdtempSync(path.join(tmpdir(), 'incr-cli-'));
  const reqPath = path.join(dir, 'request.json');
  const resPath = path.join(dir, 'response.json');
  if (typeof request === 'string') {
    writeFileSync(reqPath, request);
  } else {
    writeFileSync(reqPath, JSON.stringify(request));
  }
  const inFd = openSync(reqPath, 'r');
  const outFd = openSync(resPath, 'w');
  const proc = spawnSync(process.execPath, [CLI], { stdio: [inFd, outFd, 'inherit'] });
  closeSync(inFd);
  closeSync(outFd);
  assert.equal(proc.status, 0, `cli exited ${proc.status}`);
  return JSON.parse(readFileSync(resPath, 'utf8'));
}

const TASKS = {
  a: { input: 'i', version: 'v1', deps: [] },
  b: { input: 'i', version: 'v1', deps: ['a'] },
  c: { input: 'i', version: 'v1', deps: ['a'] },
  d: { input: 'i', version: 'v1', deps: ['b', 'c'] },
};

test('cli reads request from stdin and recomputes the invalidated closure', () => {
  const out = runCli({
    tasks: TASKS,
    transaction: { setVersion: { a: 'v2' } },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.recomputed, ['a', 'b', 'c', 'd']);
  assert.deepEqual(Object.keys(out.diff).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(out.stopPoints, ['d']);
  for (const [id, d] of Object.entries(out.diff)) {
    assert.notEqual(d.from, d.to);
    assert.equal(out.hashes[id], d.to);
  }
});

test('cli reports E_BUDGET over budget and E_CYCLE on cycles', () => {
  const budget = runCli({
    tasks: TASKS,
    transaction: { setVersion: { a: 'v2' } },
    maxRecompute: 2,
  });
  assert.deepEqual(budget, { ok: false, error: 'E_BUDGET', needed: 4, budget: 2 });

  const cycle = runCli({
    tasks: TASKS,
    transaction: { addDeps: { a: ['d'] } },
  });
  assert.deepEqual(cycle, { ok: false, error: 'E_CYCLE' });

  const selfLoop = runCli({
    tasks: { a: { input: 'i', version: 'v1', deps: ['a'] } },
    transaction: {},
  });
  assert.deepEqual(selfLoop, { ok: false, error: 'E_CYCLE' });
});

test('cli handles a no-change transaction', () => {
  const out = runCli({ tasks: TASKS, transaction: {} });
  assert.equal(out.ok, true);
  assert.deepEqual(out.recomputed, []);
  assert.deepEqual(out.diff, {});
  assert.deepEqual(out.stopPoints, []);
});

test('cli rejects malformed JSON on stdin', () => {
  const out = runCli('not json');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'E_BAD_REQUEST');
});
