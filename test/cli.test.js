import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliSession } from '../lib/session.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

// Sandboxed environments may block spawning child processes; probe once and
// skip the process-level end-to-end tests if so.
const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
const canSpawn = probe.stdout === 'ok';

const DIAMOND = [
  { cmd: 'add-edge', from: 'S', to: 'A', capacity: 5 },
  { cmd: 'add-edge', from: 'S', to: 'B', capacity: 4 },
  { cmd: 'add-edge', from: 'A', to: 'C', capacity: 5 },
  { cmd: 'add-edge', from: 'B', to: 'C', capacity: 4 },
];

const toNdjson = (commands) => commands.map((c) => JSON.stringify(c)).join('\n') + '\n';

function runInProcess(commands) {
  return new CliSession().run(toNdjson(commands));
}

test('cli session: freeze, partial release, re-freeze within capacity', () => {
  const { outputs, exitCode } = runInProcess([
    ...DIAMOND,
    { cmd: 'freeze', source: 'S', target: 'C', amount: 9 },
    { cmd: 'release', freezeId: 'f1', amount: 4 },
    { cmd: 'freeze', source: 'S', target: 'C', amount: 4 },
    { cmd: 'freeze', source: 'S', target: 'C', amount: 1 },
  ]);
  assert.equal(exitCode, 0);
  assert.equal(outputs.length, 8);
  const [f1, rel, f2, f3] = outputs.slice(4);
  assert.equal(f1.ok, true);
  assert.equal(f1.freezeId, 'f1');
  assert.equal(f1.flows.reduce((sum, f) => sum + (f.from === 'S' ? f.amount : 0), 0), 9);
  assert.deepEqual(rel, { ok: true, freezeId: 'f1', released: 4, remaining: 5 });
  assert.equal(f2.ok, true);
  assert.equal(f3.ok, false);
  assert.equal(f3.reason, 'insufficient-capacity');
  assert.equal(f3.maxFreezable, 0);
  assert.equal(f3.cut.capacity, 0);
});

test('cli session: declined freeze carries a cut certificate and is not fatal', () => {
  const { outputs, exitCode } = runInProcess([
    ...DIAMOND,
    { cmd: 'freeze', source: 'S', target: 'C', amount: 10 },
    { cmd: 'freeze', source: 'S', target: 'C', amount: 9 },
  ]);
  assert.equal(exitCode, 0, 'declined freeze is not a command error');
  const [declined, accepted] = outputs.slice(4);
  assert.equal(declined.ok, false);
  assert.equal(declined.maxFreezable, 9);
  assert.equal(declined.cut.capacity, 9);
  assert.ok(declined.cut.nodes.includes('C'));
  assert.ok(declined.cut.edges.length > 0);
  assert.equal(accepted.ok, true, 'session continues after a declined freeze');
});

test('cli session: command errors are JSON with exit code 1 and stop processing', () => {
  const cases = [
    { commands: [{ cmd: 'freeze', source: 'ghost', target: 'C', amount: 1 }], code: 'UNKNOWN_SOURCE' },
    { commands: [...DIAMOND, { cmd: 'release', freezeId: 'f99' }], code: 'UNKNOWN_FREEZE' },
    {
      commands: [
        ...DIAMOND,
        { cmd: 'freeze', source: 'S', target: 'C', amount: 3 },
        { cmd: 'release', freezeId: 'f1', amount: 10 },
      ],
      code: 'OVER_RELEASE',
    },
    {
      commands: [
        ...DIAMOND,
        { cmd: 'freeze', source: 'S', target: 'C', amount: 3 },
        { cmd: 'release', freezeId: 'f1' },
        { cmd: 'release', freezeId: 'f1' },
      ],
      code: 'DUPLICATE_RELEASE',
    },
    { commands: [{ cmd: 'set-capacity', from: 'A', to: 'B', capacity: 1 }], code: 'UNKNOWN_EDGE' },
    { commands: [{ cmd: 'teleport', from: 'A' }], code: 'UNKNOWN_COMMAND' },
  ];
  for (const { commands, code } of cases) {
    const { outputs, exitCode } = runInProcess([...commands, { cmd: 'add-edge', from: 'Z', to: 'Y', capacity: 1 }]);
    assert.equal(exitCode, 1, `expected exit 1 for ${code}`);
    const last = outputs.at(-1);
    assert.equal(last.ok, false);
    assert.equal(last.code, code);
    assert.equal(typeof last.error, 'string');
  }
});

test('cli session: malformed JSON line is INVALID_COMMAND with exit 1', () => {
  const { outputs, exitCode } = new CliSession().run('{"cmd":"add-edge",broken\n');
  assert.equal(exitCode, 1);
  assert.equal(outputs.at(-1).ok, false);
  assert.equal(outputs.at(-1).code, 'INVALID_COMMAND');
});

test('cli process: NDJSON over stdin, JSON responses, exit codes', { skip: !canSpawn }, () => {
  const ok = spawnSync(process.execPath, [CLI], {
    input: toNdjson([
      ...DIAMOND,
      { cmd: 'freeze', source: 'S', target: 'C', amount: 9 },
      { cmd: 'release', freezeId: 'f1', amount: 4 },
      { cmd: 'freeze', source: 'S', target: 'C', amount: 4 },
    ]),
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0);
  const lines = ok.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 7);
  assert.equal(lines[4].freezeId, 'f1');
  assert.deepEqual(lines[5], { ok: true, freezeId: 'f1', released: 4, remaining: 5 });
  assert.equal(lines[6].ok, true);

  const bad = spawnSync(process.execPath, [CLI], {
    input: toNdjson([...DIAMOND, { cmd: 'release', freezeId: 'f1' }]),
    encoding: 'utf8',
  });
  assert.equal(bad.status, 1, 'command error exits with code 1');
  const errLine = JSON.parse(bad.stdout.trim().split('\n').at(-1));
  assert.equal(errLine.ok, false);
  assert.equal(errLine.code, 'UNKNOWN_FREEZE');
});
