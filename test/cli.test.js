import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { main } from '../cli.js';

// NOTE: the sandbox used for development blocks child-process spawning, so
// the CLI is tested through its in-process entry point main(argv, stdin),
// which is exactly what the `node cli.js` wrapper invokes.

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'woindex-cli-'));
}

function run(dir, command, input = '') {
  return main(['--dir', dir, command], input);
}

test('cli: full lifecycle add -> query -> del -> undo -> verify', () => {
  const dir = tmpDir();
  const add = run(dir, 'add', '{"id":"WO-1001","version":1,"text":"巡检发现3号泵轴承过热，立即停机"}\n{"id":"WO-1002","version":1,"text":"轴承温度正常"}\n');
  assert.equal(add.code, 0);
  assert.deepEqual(add.lines[0], { ok: true, batch: 1, count: 2 });

  const query = run(dir, 'query', '{"phrase":"轴承 过热"}\n{"near":["轴承","过热"],"k":1}\n');
  assert.equal(query.code, 0);
  assert.equal(query.lines.length, 2);
  assert.deepEqual(query.lines[0].results, [{ id: 'WO-1001', version: 1, matches: [[7, 10]] }]);
  assert.deepEqual(query.lines[1].results, [{ id: 'WO-1001', version: 1, matches: [[7, 8, 9, 10]] }]);

  const del = run(dir, 'del', '{"id":"WO-1001","version":1}\n');
  assert.equal(del.lines[0].ok, true);
  assert.deepEqual(run(dir, 'query', '{"phrase":"轴承 过热"}\n').lines[0].results, []);

  const undo = run(dir, 'undo', '{"batch":2}\n');
  assert.equal(undo.lines[0].ok, true);
  assert.equal(undo.lines[0].indexHash, undo.lines[0].rebuildHash);
  assert.equal(run(dir, 'query', '{"phrase":"轴承 过热"}\n').lines[0].results.length, 1);

  const verify = run(dir, 'verify');
  assert.equal(verify.code, 0);
  assert.equal(verify.lines[0].ok, true);
  assert.deepEqual(verify.lines[0].reverted, [2]);
});

test('cli: E_PARSE on malformed JSONL and missing fields, state untouched', () => {
  const dir = tmpDir();
  run(dir, 'add', '{"id":"WO-1","version":1,"text":"轴承过热"}\n');
  const journalBefore = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');

  const bad = run(dir, 'add', '{not json}\n');
  assert.equal(bad.code, 1);
  assert.equal(bad.lines[0].error.code, 'E_PARSE');

  const missing = run(dir, 'add', '{"id":"WO-2","version":1}\n');
  assert.equal(missing.lines[0].error.code, 'E_PARSE');

  const badQuery = run(dir, 'query', '{"near":["轴承"]}\n');
  assert.equal(badQuery.lines[0].error.code, 'E_PARSE');

  const badNearK = run(dir, 'query', '{"near":["轴承","过热"],"k":-1}\n');
  assert.equal(badNearK.lines[0].error.code, 'E_PARSE');

  assert.equal(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), journalBefore);
});

test('cli: E_NOTFOUND for unknown delete/undo targets', () => {
  const dir = tmpDir();
  run(dir, 'add', '{"id":"WO-1","version":1,"text":"轴承过热"}\n');
  const del = run(dir, 'del', '{"id":"WO-9","version":1}\n');
  assert.equal(del.code, 1);
  assert.equal(del.lines[0].error.code, 'E_NOTFOUND');
  const undo = run(dir, 'undo', '{"batch":42}\n');
  assert.equal(undo.lines[0].error.code, 'E_NOTFOUND');
});

test('cli: E_UNDO when reverting the same batch twice', () => {
  const dir = tmpDir();
  run(dir, 'add', '{"id":"WO-1","version":1,"text":"轴承过热"}\n');
  assert.equal(run(dir, 'undo', '{"batch":1}\n').lines[0].ok, true);
  const again = run(dir, 'undo', '{"batch":1}\n');
  assert.equal(again.code, 1);
  assert.equal(again.lines[0].error.code, 'E_UNDO');
});

test('cli: E_CORRUPT from verify after journal tamper', () => {
  const dir = tmpDir();
  run(dir, 'add', '{"id":"WO-1","version":1,"text":"轴承过热"}\n');
  assert.equal(run(dir, 'verify').lines[0].ok, true);
  const journal = path.join(dir, 'journal.jsonl');
  const raw = fs.readFileSync(journal, 'utf8');
  fs.writeFileSync(journal, raw.replace(/"seq":1/, '"seq":7'));
  const verify = run(dir, 'verify');
  assert.equal(verify.code, 1);
  assert.equal(verify.lines[0].ok, false);
  assert.equal(verify.lines[0].error.code, 'E_CORRUPT');
});

test('cli: unknown command exits with usage', () => {
  const dir = tmpDir();
  const result = run(dir, 'bogus');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage/);
});
