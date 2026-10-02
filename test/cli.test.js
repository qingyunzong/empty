import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  return text ? text.split('\n').map((l) => JSON.parse(l)) : [];
}

function capture() {
  return { text: '', write(s) { this.text += s; return true; } };
}

test('cli: fill release writes batches/transitions/comp/late outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-release-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(inDir);
  const events = [
    { kind: 'cip', eventTs: 0, line: 'L1', start: -60_000, end: 0, ok: true, op: 'c1' },
    { kind: 'fill', eventTs: 10_000, batch: 'b1', vol: 500, weight: 505, op: 'f1' },
    { kind: 'lab', eventTs: 20_000, batch: 'b1', pass: true, op: 'l1' },
    { kind: 'retract', eventTs: 30_000, target: 'lab', id: 'l1' },
    { kind: 'fill', eventTs: 40_000, batch: 'b2', vol: 0, weight: 100, op: 'f2' },
    { kind: 'fill', eventTs: 10_000_000, batch: 'b3', vol: 100, weight: 100, op: 'f3' },
    { kind: 'lab', eventTs: 50_000, batch: 'b1', pass: true, op: 'l2' }, // late vs watermark
  ];
  fs.writeFileSync(path.join(inDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const stdout = capture();
  const stderr = capture();
  const code = run(['release', '--in', inDir, '--out', outDir], { stdout, stderr });
  assert.equal(code, 0);
  assert.match(stderr.text, /VOL_INVALID/);
  assert.match(stdout.text, /batches=3/);

  for (const name of ['batches.jsonl', 'transitions.jsonl', 'comp.jsonl', 'late.log']) {
    assert.ok(fs.existsSync(path.join(outDir, name)), `missing ${name}`);
  }

  const batches = Object.fromEntries(readJsonl(path.join(outDir, 'batches.jsonl')).map((b) => [b.batch, b]));
  assert.equal(batches.b1.status, 'RELEASE'); // retracted lab replaced by late lab l2
  assert.equal(batches.b2.status, 'REJECT');
  assert.equal(batches.b2.reason, 'VOL_INVALID');
  assert.equal(batches.b3.status, 'HOLD'); // no lab

  const comp = readJsonl(path.join(outDir, 'comp.jsonl'));
  assert.equal(comp.length, 1);
  assert.equal(comp[0].batch, 'b1');

  const transitions = readJsonl(path.join(outDir, 'transitions.jsonl'));
  assert.deepEqual(
    transitions.filter((t) => t.batch === 'b1').map((t) => [t.from, t.to]),
    [['HOLD', 'RELEASE'], ['RELEASE', 'HOLD'], ['HOLD', 'RELEASE']],
  );

  const late = readJsonl(path.join(outDir, 'late.log'));
  assert.equal(late.length, 1);
  assert.equal(late[0].ref, 'l2');
});

test('cli: bad usage exits 2', () => {
  const stderr = capture();
  assert.equal(run([], { stdout: capture(), stderr }), 2);
  assert.match(stderr.text, /usage: fill release/);
  assert.equal(run(['release', '--in', '/tmp/x'], { stdout: capture(), stderr }), 2);
});

test('cli: malformed lines are reported and exit 1, valid events still processed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-release-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(inDir);
  fs.writeFileSync(path.join(inDir, 'events.jsonl'), [
    '{"kind":"cip","eventTs":0,"line":"L1","start":-60000,"end":0,"ok":true,"op":"c1"}',
    'not json',
    '{"kind":"fill","eventTs":10000,"batch":"b1","vol":100,"weight":100,"op":"f1"}',
    '',
  ].join('\n'));
  const stderr = capture();
  const code = run(['release', '--in', inDir, '--out', outDir], { stdout: capture(), stderr });
  assert.equal(code, 1);
  assert.match(stderr.text, /PARSE_ERROR|SyntaxError|events.jsonl:2/);
  const batches = readJsonl(path.join(outDir, 'batches.jsonl'));
  assert.equal(batches[0].batch, 'b1');
  assert.equal(batches[0].status, 'HOLD');
});
