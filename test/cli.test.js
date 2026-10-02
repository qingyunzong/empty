'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../src/cli');

function makeWorkspace(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-life-'));
  const inDir = path.join(root, 'in');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(inDir);
  fs.writeFileSync(path.join(inDir, 'events.jsonl'), lines.join('\n') + '\n');
  return { root, inDir, outDir };
}

function fakeIo() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      stdout: { write: (s) => { out.stdout += s; } },
      stderr: { write: (s) => { out.stderr += s; } },
    },
  };
}

const readJsonl = (file) =>
  fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('CLI end-to-end: outputs 4 files, late qc rewrites risk chain, LIFE_INVALID reported', () => {
  const { inDir, outDir } = makeWorkspace([
    '{"type":"change","eventTs":0,"tool":"T1","newLife":10,"op":"c1"}',
    '{"type":"load","eventTs":10000,"tool":"T1","part":"P1","force":100,"seconds":1,"op":"l1"}',
    '{"type":"load","eventTs":20000,"tool":"T1","part":"P2","force":200,"seconds":1,"op":"l2"}',
    '{"type":"load","eventTs":30000,"tool":"T1","part":"P3","force":100,"seconds":1,"op":"l3"}',
    '{"type":"change","eventTs":31000,"tool":"T1","newLife":0,"op":"c2"}', // LIFE_INVALID
    '{"type":"qc","eventTs":15000,"part":"P1","ok":false,"op":"q1"}',     // late (wm=27000)
  ]);

  const { out, io } = fakeIo();
  const code = main(['life', '--in', inDir, '--out', outDir], io);
  assert.equal(code, 0);
  assert.match(out.stdout, /parts=3/);
  assert.match(out.stderr, /LIFE_INVALID tool=T1 op=c2 newLife=0/);

  for (const name of ['tools.jsonl', 'parts.jsonl', 'risk.json', 'late.log']) {
    assert.ok(fs.existsSync(path.join(outDir, name)), `${name} exists`);
  }

  const tools = readJsonl(path.join(outDir, 'tools.jsonl'));
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool, 'T1');
  assert.equal(tools[0].segments.length, 1); // invalid change skipped
  assert.equal(tools[0].segments[0].wear, 6); // 1 + 4 + 1
  assert.equal(tools[0].segments[0].exhausted, false);

  const parts = readJsonl(path.join(outDir, 'parts.jsonl'));
  const riskOf = (p) => parts.find((x) => x.part === p).risk;
  assert.equal(riskOf('P1'), 'BAD');
  assert.equal(riskOf('P2'), 'RISK');
  assert.equal(riskOf('P3'), 'RISK');

  const risk = JSON.parse(fs.readFileSync(path.join(outDir, 'risk.json'), 'utf8'));
  assert.equal(risk.watermark, 31000 - 4000);
  assert.deepEqual(risk.counts, { GOOD: 0, BAD: 1, UNKNOWN: 0, RISK: 2 });
  assert.deepEqual(risk.riskParts, ['P2', 'P3']);
  assert.deepEqual(risk.badParts, ['P1']);
  assert.equal(risk.lateCount, 1);
  assert.deepEqual(risk.errors, [
    { code: 'LIFE_INVALID', tool: 'T1', op: 'c2', newLife: 0 },
  ]);

  const lateLog = fs.readFileSync(path.join(outDir, 'late.log'), 'utf8');
  assert.match(lateLog, /^LATE kind=qc id=q1 eventTs=15000 watermark=27000\n$/);
});

test('CLI: load retract via input stream restores tool segment', () => {
  const { inDir, outDir } = makeWorkspace([
    '{"type":"change","eventTs":0,"tool":"T1","newLife":1,"op":"c1"}',
    '{"type":"load","eventTs":1000,"tool":"T1","part":"P1","force":100,"seconds":0.5,"op":"l1"}',
    '{"type":"load","eventTs":2000,"tool":"T1","part":"P2","force":100,"seconds":0.6,"op":"l2"}',
    '{"type":"retract","eventTs":3000,"kind":"load","id":"l2"}',
  ]);
  const { io } = fakeIo();
  assert.equal(main(['life', '--in', inDir, '--out', outDir], io), 0);
  const tools = readJsonl(path.join(outDir, 'tools.jsonl'));
  assert.equal(tools[0].segments[0].wear, 0.5);
  assert.equal(tools[0].segments[0].exhausted, false);
  const parts = readJsonl(path.join(outDir, 'parts.jsonl'));
  assert.deepEqual(parts.map((p) => [p.part, p.risk]), [['P1', 'UNKNOWN']]);
});

test('CLI usage error without --in/--out exits 2', () => {
  const { out, io } = fakeIo();
  assert.equal(main(['life'], io), 2);
  assert.match(out.stderr, /usage: tool life/);
  assert.equal(main(['bogus'], io), 2);
});
