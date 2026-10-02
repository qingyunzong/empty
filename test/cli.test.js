import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACHINE_DSL } from './helpers.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function setup(files) {
  const dir = mkdtempSync(join(tmpdir(), 'interlock-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

// Capture child stdio via file redirection (pipes are not reliable here).
function runCli(args, dir) {
  const outPath = join(dir, 'stdout.txt');
  const errPath = join(dir, 'stderr.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: r.status,
    error: r.error,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
}

const GOOD_COMMANDS = [
  { tick: 0, cmd: 'set_input', signal: 'door_closed', value: true },
  { tick: 1, cmd: 'set_output', signal: 'motor', value: true },
  { tick: 2, cmd: 'set_output', signal: 'heater', value: true },
  { tick: 3, cmd: 'undo' },
].map((c) => JSON.stringify(c)).join('\n') + '\n';

test('cli: successful run writes trace with per-tick states and reasons (exit 0)', () => {
  const dir = setup({ 'machine.dsl': MACHINE_DSL, 'commands.jsonl': GOOD_COMMANDS });
  const trace = join(dir, 'out.json');
  const r = runCli(['run', join(dir, 'machine.dsl'), join(dir, 'commands.jsonl'), '--trace', trace], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(trace));
  const out = JSON.parse(readFileSync(trace, 'utf8'));
  assert.equal(out.accepted, 3);
  assert.equal(out.rejected, 1);
  assert.equal(out.entries.length, 4);
  assert.equal(out.entries[0].tick, 0);
  assert.equal(out.entries[0].accepted, true);
  assert.equal(out.entries[2].accepted, false);
  assert.match(out.entries[2].reason, /invariant violated/);
  assert.equal(out.entries[2].state.values.motor, true, 'rejected command leaves state unchanged');
  assert.equal(out.entries[3].state.values.motor, false, 'undo restores the previous committed state');
});

test('cli: DSL errors are reported with line:col and exit code 2', () => {
  const dir = setup({
    'bad.dsl': 'signal a : input bool\nsignal a : output bool\n',
    'commands.jsonl': '',
  });
  const r = runCli(['run', join(dir, 'bad.dsl'), join(dir, 'commands.jsonl')], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad\.dsl:2:8: error: duplicate signal 'a'/);
});

test('cli: DSL type error also exits 2', () => {
  const dir = setup({
    'bad.dsl': 'signal t : timer ms = 0ms\ninvariant not t\n',
    'commands.jsonl': '',
  });
  const r = runCli(['run', join(dir, 'bad.dsl'), join(dir, 'commands.jsonl')], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad\.dsl:2:11: error:/);
});

test('cli: missing files and bad usage exit 1', () => {
  const dir = setup({});
  const r1 = runCli(['run', '/nonexistent.dsl', '/nonexistent.jsonl'], dir);
  assert.equal(r1.status, 1);
  const r2 = runCli([], dir);
  assert.equal(r2.status, 1);
  const r3 = runCli(['bogus'], dir);
  assert.equal(r3.status, 1);
});

test('cli: invalid commands JSONL exits 3 with line number', () => {
  const dir = setup({ 'machine.dsl': MACHINE_DSL, 'commands.jsonl': '{"tick":0}\nnot json\n' });
  const r = runCli(['run', join(dir, 'machine.dsl'), join(dir, 'commands.jsonl')], dir);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /commands\.jsonl:2: invalid JSON/);
});

test('cli: without --trace the trace goes to stdout', () => {
  const dir = setup({ 'machine.dsl': MACHINE_DSL, 'commands.jsonl': GOOD_COMMANDS });
  const r = runCli(['run', join(dir, 'machine.dsl'), join(dir, 'commands.jsonl')], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.entries.length, 4);
});
