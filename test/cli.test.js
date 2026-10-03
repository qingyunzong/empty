import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

let dir;
let s1;
let s2;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'qfr-'));
  s1 = join(dir, 's1.json');
  s2 = join(dir, 's2.json');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args) {
  const { code, stdout } = runCli(args);
  assert.equal(code, 0, `expected exit 0, got ${code}: ${stdout}`);
  return JSON.parse(stdout);
}

function runExpectError(args, expectedCode) {
  const { code, stdout } = runCli(args);
  assert.equal(code, 1, `expected exit 1, got ${code}`);
  assert.deepEqual(JSON.parse(stdout), { error: expectedCode });
}

test('CLI end-to-end: init, member lifecycle, freeze, diff, merge, account', () => {
  const init1 = run(['init', '--state', s1, '{"account":"acct","total":100,"memberId":"m1"}']);
  assert.equal(init1.accounts.acct.available, 100);
  run(['init', '--state', s2, '{"account":"acct","total":100,"memberId":"m1"}']);

  const addEvent = run(['add-member', '--state', s1, '{"member":"m2","by":"m1"}']);
  assert.equal(addEvent.type, 'add-member');
  const freezeEvent = run([
    'freeze', '--state', s1,
    '{"requestId":"r1","account":"acct","amount":40,"memberId":"m2"}',
  ]);
  assert.equal(freezeEvent.type, 'freeze');
  assert.equal(freezeEvent.epoch, 1);

  const diff = run(['diff', '--state', s2, s1]);
  assert.deepEqual(diff.missingFreezes, [freezeEvent.id]);
  assert.deepEqual(diff.missingMembers, [addEvent.id]);
  assert.deepEqual(diff.missingReleases, []);

  const merged = run(['merge', '--state', s2, s1]);
  assert.equal(merged.applied.length, 2);
  assert.equal(merged.rejected.length, 0);

  const account = run(['account', '--state', s2]);
  assert.equal(account.accounts.acct.frozen, 40);
  assert.equal(account.accounts.acct.available, 60);
  assert.equal(account.epoch, 1);
});

test('CLI errors: limit-exceeded, remove-incomplete, stale-member exit 1 with JSON error', () => {
  runExpectError([
    'freeze', '--state', s2,
    '{"requestId":"r2","account":"acct","amount":70,"memberId":"m1"}',
  ], 'limit-exceeded');

  runExpectError([
    'remove-member', '--state', s2,
    '{"member":"m2","by":"m1","frontier":{}}',
  ], 'remove-incomplete');

  const removed = run(['remove-member', '--state', s2, '{"member":"m2","by":"m1"}']);
  assert.equal(removed.type, 'remove-member');

  runExpectError([
    'freeze', '--state', s2,
    '{"requestId":"r3","account":"acct","amount":5,"memberId":"m2"}',
  ], 'stale-member');

  const account = run(['account', '--state', s2]);
  assert.equal(account.accounts.acct.frozen, 40);
  assert.equal(account.members.m2.active, false);
});

test('CLI: unknown command and missing state exit 1', () => {
  runExpectError(['bogus', '--state', s1], 'unknown-command');
  runExpectError(['account', '--state', join(dir, 'nope.json')], 'no-state');
  runExpectError(['freeze', '--state', s1, '{"requestId":"r4"}'], 'bad-request');
});
