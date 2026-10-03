import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePackage, readIndex, buildRecord } from '../src/package.js';
import { DEMO_PROGRAM, DEMO_TRACE, readEvents, runCli, summaryOf } from '../support/helpers.mjs';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-persist-'));
  const base = path.join(dir, 'demo');
  const index = encodePackage(DEMO_PROGRAM, base, { blockLines: 3, name: 'demo' });
  return { dir, base, index };
}

test('encode leaves no temp files and index holds name, range, entry offset', () => {
  const { dir, index } = setup();
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.equal(index.programName, 'demo');
  assert.deepEqual(index.range, { first: 0, last: 4 });
  assert.deepEqual(index.entry, { seq: 0, offset: 0 });
  assert.equal(index.blocks.length, 5);
});

test('crash before index rename: unindexed tail is ignored', () => {
  const { dir, base } = setup();
  // Simulate a crashed append: extra block in the data file, index not updated.
  fs.appendFileSync(`${base}.blk`, buildRecord(5, 'G1 X8 Y8'));
  const v = runCli(['verify', base]);
  assert.equal(v.code, 0, v.stderr);
  const parsed = JSON.parse(v.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /unindexed tail/);
  const d = runCli(['decode', base, '--events', path.join(dir, 'ev.jsonl')]);
  assert.equal(d.code, 0, d.stderr);
  const summary = summaryOf(d.stdout);
  assert.equal(summary.done, true);
  assert.equal(summary.confirmed, 5);
});

test('stale index after crash: unindexed tail is ignored, index is authoritative', () => {
  const { dir, base, index } = setup();
  // Simulate crash between data append and index rename: index covers only 3 blocks.
  const stale = {
    ...index,
    blockCount: 3,
    range: { first: 0, last: 2 },
    blocks: index.blocks.slice(0, 3),
  };
  fs.writeFileSync(`${base}.idx`, JSON.stringify(stale));
  const d = runCli(['decode', base, '--events', path.join(dir, 'ev.jsonl')]);
  assert.equal(d.code, 0, d.stderr);
  const summary = summaryOf(d.stdout);
  assert.equal(summary.confirmed, 3);
  assert.equal(summary.next, 3);
  // Only the indexed prefix is visible: execution stops after the first move,
  // far short of the full 10-move trace, and never touches the tail blocks.
  const events = readEvents(path.join(dir, 'ev.jsonl'));
  assert.deepEqual(events, DEMO_TRACE.slice(0, 1));
});

test('state file round-trips through tmp+rename without leftovers', () => {
  const { dir, base } = setup();
  const state = path.join(dir, 's.json');
  const r1 = runCli(['decode', base, '--upto', '2', '--state', state]);
  assert.equal(r1.code, 0, r1.stderr);
  assert.ok(fs.existsSync(state));
  assert.ok(!fs.existsSync(`${state}.tmp`));
  const r2 = runCli(['decode', base, '--from', '2', '--state', state, '--events', path.join(dir, 'ev.jsonl')]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(summaryOf(r2.stdout).done, true);
});
