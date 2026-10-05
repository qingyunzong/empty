import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// The sandboxed environment cannot pipe grandchild stdio, so capture via files.
function run(args) {
  const outFile = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-out-'));
  const outPath = path.join(outFile, 'out');
  const errPath = path.join(outFile, 'err');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const result = {
    status: r.status,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
  fs.rmSync(outFile, { recursive: true, force: true });
  return result;
}

test('CLI error codes and exit statuses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-cli-'));
  let r = run(['freeze', '--archive', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^E_WINDOW/);

  assert.equal(run(['append', '--archive', dir, '--ts', '1', '--device', 'd1', '--tokens', 'x y']).status, 0);
  assert.equal(run(['freeze', '--archive', dir]).status, 0);

  r = run(['merge', '--archive', dir, '--from', '0', '--to', '10']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^E_MERGE/);

  r = run(['retain', '--archive', dir, '--before', 'abc']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^E_RETAIN/);

  r = run(['query', '--archive', dir, '--phrase', 'x y']);
  assert.equal(r.status, 0);
  const hit = JSON.parse(r.stdout.trim());
  assert.equal(hit.type, 'phrase');
  assert.equal(hit.events[0], 'e00000001');

  r = run(['stats', '--archive', dir]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).totalEvents, 1);

  // active events overlapping the frozen window are rejected with E_WINDOW
  assert.equal(run(['append', '--archive', dir, '--ts', '0', '--device', 'd1', '--tokens', 'old']).status, 0);
  r = run(['freeze', '--archive', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^E_WINDOW/);
  fs.rmSync(dir, { recursive: true, force: true });
});
