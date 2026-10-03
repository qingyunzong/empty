import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI, DEMO_PROGRAM, DEMO_TRACE, runCli, readEvents, summaryOf } from '../support/helpers.mjs';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-resume-'));
  const prog = path.join(dir, 'demo.nc');
  const base = path.join(dir, 'demo');
  fs.writeFileSync(prog, DEMO_PROGRAM);
  const enc = runCli(['encode', prog, '-o', base, '--block-lines', '3']);
  assert.equal(enc.code, 0, enc.stderr);
  const { blocks } = JSON.parse(enc.stdout);
  return { dir, base, blocks };
}

test('cli decode of full package matches hand-enumerated trace', () => {
  const { base } = setup();
  const res = runCli(['decode', base]);
  assert.equal(res.code, 0, res.stderr);
  const events = res.stdout.split('\n').filter((l) => l && !l.includes('"summary"')).map((l) => JSON.parse(l));
  assert.deepEqual(events, DEMO_TRACE);
  const summary = summaryOf(res.stdout);
  assert.equal(summary.done, true);
  assert.equal(summary.confirmed, 5);
  assert.equal(summary.next, 5);
});

test('resume from any sequence number yields identical execution', () => {
  const { dir, base, blocks } = setup();
  const full = runCli(['decode', base, '--events', path.join(dir, 'full.jsonl')]);
  assert.equal(full.code, 0, full.stderr);
  const fullEvents = readEvents(path.join(dir, 'full.jsonl'));
  assert.deepEqual(fullEvents, DEMO_TRACE);

  for (let k = 0; k <= blocks; k++) {
    const state = path.join(dir, `state-${k}.json`);
    const e1 = path.join(dir, `e1-${k}.jsonl`);
    const e2 = path.join(dir, `e2-${k}.jsonl`);
    const r1 = runCli(['decode', base, '--upto', String(k), '--state', state, '--events', e1]);
    assert.equal(r1.code, 0, `upto ${k}: ${r1.stderr}`);
    const s1 = summaryOf(r1.stdout);
    assert.equal(s1.confirmed, k);
    assert.equal(s1.next, k);
    const r2 = runCli(['decode', base, '--from', String(k), '--state', state, '--events', e2]);
    assert.equal(r2.code, 0, `from ${k}: ${r2.stderr}`);
    const s2 = summaryOf(r2.stdout);
    assert.equal(s2.confirmed, blocks);
    assert.equal(s2.done, true);
    assert.deepEqual([...readEvents(e1), ...readEvents(e2)], fullEvents, `resume at ${k}`);
  }
});
