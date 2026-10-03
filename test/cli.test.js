import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// Spawns the CLI. stdout is captured via a temp file because grandchild
// pipes are not reliable in every sandbox; stdin is passed as a string.
function runCli(args, stdin) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'clearsync-test-'));
    const outFile = join(dir, 'out.json');
    const fd = openSync(outFile, 'w');
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', fd, 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      closeSync(fd);
      let stdout = '';
      try { stdout = readFileSync(outFile, 'utf8'); } catch { /* empty */ }
      resolve({ code, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

const VALID = {
  config: { slots: 2, capacityPerSlot: 1 },
  instructions: [
    { id: 'a', institution: 'X', amount: 5, priority: 1, deadlineSlot: 1 },
    { id: 'b', institution: 'Y', amount: 7, priority: 2, deadlineSlot: 2, dependencies: ['a'] },
  ],
};

test('CLI reads a JSON file and exits 0 on a clean schedule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clearsync-'));
  const file = join(dir, 'input.json');
  writeFileSync(file, JSON.stringify(VALID));
  const { code, stdout } = await runCli([file]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.ok(Array.isArray(out.schedule));
  assert.ok(Array.isArray(out.certificates));
  assert.deepEqual(out.errors, []);
  assert.equal(out.schedule.find((s) => s.id === 'b').slot, 2);
});

test('CLI reads from stdin when no file is given', async () => {
  const { code, stdout } = await runCli([], JSON.stringify(VALID));
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.schedule.length, 2);
});

test('CLI exits 2 with a CAPACITY error on capacity conflict', async () => {
  const input = {
    config: { slots: 1, capacityPerSlot: 1 },
    instructions: [
      { id: 'a', institution: 'X', amount: 1, priority: 1, deadlineSlot: 1 },
      { id: 'b', institution: 'Y', amount: 2, priority: 1, deadlineSlot: 1 },
    ],
  };
  const { code, stdout } = await runCli(['-'], JSON.stringify(input));
  assert.equal(code, 2);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.errors.map((e) => e.code), ['CAPACITY']);
});

test('CLI exits 2 on invalid JSON and on schema violations', async () => {
  const bad1 = await runCli(['-'], '{not json');
  assert.equal(bad1.code, 2);
  assert.equal(JSON.parse(bad1.stdout).errors[0].code, 'INVALID_INPUT');

  const bad2 = await runCli(['-'], JSON.stringify({ config: { slots: 0 }, instructions: [] }));
  assert.equal(bad2.code, 2);
  assert.equal(JSON.parse(bad2.stdout).errors[0].code, 'INVALID_INPUT');
});

test('CLI exits 2 on STALE_UNDO', async () => {
  const input = { ...VALID, undo: ['a', 'a'] };
  const { code, stdout } = await runCli(['-'], JSON.stringify(input));
  assert.equal(code, 2);
  const out = JSON.parse(stdout);
  assert.ok(out.errors.some((e) => e.code === 'STALE_UNDO'));
});
