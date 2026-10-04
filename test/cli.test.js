import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

// The sandbox forbids spawning child processes, so the CLI is driven
// in-process through main(argv, io) with captured streams.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cli-'));
  const gateDir = join(dir, '.gate');
  const run = (args) => {
    let stdout = '';
    let stderr = '';
    const status = main(args, {
      out: (s) => { stdout += s; },
      err: (s) => { stderr += s; },
      env: { GATE_DIR: gateDir },
    });
    return { status, stdout, stderr };
  };
  const write = (name, content) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };
  return { run, write };
}

const RULES = JSON.stringify({
  rules: [
    { id: 'temp-max', when: { cmp: 'le', left: { ref: 'temp' }, right: { lit: 30 } } },
    { id: 'hum-known', when: { cmp: 'lt', left: { ref: 'hum' }, right: { lit: 90 } } },
  ],
});

test('CLI: init validates rules and reports E_RULE / E_WINDOW', () => {
  const { run, write } = setup();
  const good = write('rules.json', RULES);
  const ok = run(['init', good]);
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout).rules, 2);

  const again = run(['init', good]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /E_RULE/);

  const badRule = write('bad.json', JSON.stringify({ rules: [{ id: 'x', when: { cmp: '??', left: { lit: 1 }, right: { lit: 2 } } }] }));
  const r1 = run(['init', badRule, '--force']);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /E_RULE/);

  const badWindow = write('badwin.json', JSON.stringify({
    rules: [{ id: 'x', when: { cmp: 'eq', left: { agg: 'sum', window: { size: -1 }, expr: { ref: 'v' } }, right: { lit: 0 } } }],
  }));
  const r2 = run(['init', badWindow, '--force']);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /E_WINDOW/);
});

test('CLI: obs / decide exit codes, E_UNDECIDED_BLOCK, correct, replay', () => {
  const { run, write } = setup();
  const rulesPath = write('rules.json', RULES);
  assert.equal(run(['init', rulesPath]).status, 0);

  const obsPath = write('obs.jsonl', [
    JSON.stringify({ key: 'ok', time: 1000, temp: 20, hum: 50 }),
    JSON.stringify({ key: 'hot', time: 2000, temp: 35, hum: 50 }),
    JSON.stringify({ key: 'unknown', time: 3000, temp: 20 }),
  ].join('\n'));
  const obs = run(['obs', obsPath]);
  assert.equal(obs.status, 0);
  assert.deepEqual(JSON.parse(obs.stdout), { ingested: 3 });

  const pass = run(['decide', 'ok']);
  assert.equal(pass.status, 0);
  const passCert = JSON.parse(pass.stdout);
  assert.equal(passCert.decision, 'pass');
  assert.equal(passCert.admissible, true);
  assert.ok(Array.isArray(passCert.windowKeys));
  assert.ok(Array.isArray(passCert.exemptionChain));
  assert.match(passCert.rules[0].astHash, /^[0-9a-f]{16}$/);

  const fail = run(['decide', 'hot']);
  assert.equal(fail.status, 2);
  assert.equal(JSON.parse(fail.stdout).violation, true);

  const undecided = run(['decide', 'unknown']);
  assert.equal(undecided.status, 3);
  assert.match(undecided.stderr, /E_UNDECIDED_BLOCK/);
  const undecidedCert = JSON.parse(undecided.stdout);
  assert.equal(undecidedCert.decision, 'undecided');
  assert.equal(undecidedCert.violation, false);
  assert.equal(undecidedCert.admissible, false);

  // Correction goes through the same decision pipeline.
  const corrected = run(['correct', 'hot', '{"temp": 25}']);
  assert.equal(corrected.status, 0);
  assert.equal(JSON.parse(corrected.stdout).decision, 'pass');

  const replay = run(['replay', '0', '5000']);
  assert.equal(replay.status, 0);
  const lines = replay.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => JSON.parse(l).mode === 'replay'));

  const isoReplay = run(['replay', '1970-01-01T00:00:00Z', '1970-01-01T00:00:05Z']);
  assert.equal(isoReplay.status, 0);
  assert.equal(isoReplay.stdout.trim().split('\n').length, 3);

  const badRange = run(['replay', '5000', '0']);
  assert.equal(badRange.status, 1);
  assert.match(badRange.stderr, /E_WINDOW/);
});

test('CLI: duplicate key rejected with E_OBS; unknown key on decide', () => {
  const { run, write } = setup();
  const rulesPath = write('rules.json', RULES);
  run(['init', rulesPath]);
  const obsPath = write('obs.jsonl', JSON.stringify({ key: 'a', time: 1, temp: 1, hum: 1 }));
  assert.equal(run(['obs', obsPath]).status, 0);
  const dup = run(['obs', obsPath]);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /E_OBS/);
  const missing = run(['decide', 'nope']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /E_OBS/);
});

test('CLI: exemption tie surfaces E_EXEMPT with exit 1', () => {
  const { run, write } = setup();
  const rulesPath = write('rules.json', JSON.stringify({
    rules: [{ id: 'r1', when: { cmp: 'lt', left: { ref: 'v' }, right: { lit: 10 } } }],
    exemptions: [
      { id: 'x-a', priority: 10 },
      { id: 'x-b', priority: 10 },
    ],
  }));
  run(['init', rulesPath]);
  const obsPath = write('obs.jsonl', JSON.stringify({ key: 'o1', time: 1, v: 50 }));
  run(['obs', obsPath]);
  const res = run(['decide', 'o1']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /E_EXEMPT/);
});
