'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTracks, main } = require('../src/cli');

const EVENTS = [
  { type: 'GROUND_OBSERVATION', obsId: 'O1', ts: 100, x: 5, y: 5 },
  { type: 'FLIGHT_PLAN', flightId: 'F1', start: 0, end: 200, polygon: [[0, 0], [10, 0], [10, 10], [0, 10]], version: 1 },
  { type: 'GROUND_OBSERVATION', obsId: 'O2', ts: 101, x: 50, y: 50 },
  { type: 'WATERMARK', ts: 200 },
];

test('cli tracks --in emits JSONL actions and certificates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-'));
  const inFile = path.join(dir, 'events.jsonl');
  fs.writeFileSync(inFile, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const stdout = runTracks(inFile);
  const actions = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(
    actions.map((a) => a.type),
    ['UNMATCHED', 'PLAN_ACCEPTED', 'MATCH', 'UNMATCHED', 'CERTIFICATE', 'CERTIFICATE'],
  );
  assert.equal(actions[2].flightId, 'F1');
  assert.equal(actions[4].obsId, 'O1');
  assert.equal(actions[4].matched, true);
  assert.equal(actions[5].obsId, 'O2');
  assert.equal(actions[5].matched, false);
});

test('cli reports MALFORMED for invalid JSON lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-'));
  const inFile = path.join(dir, 'events.jsonl');
  fs.writeFileSync(inFile, '{"type":"WATERMARK","ts":10}\nnot json\n');
  const stdout = runTracks(inFile);
  const actions = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(actions.map((a) => a.type), ['MALFORMED']);
});

test('cli main writes actions to stdout callback and returns 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-'));
  const inFile = path.join(dir, 'events.jsonl');
  fs.writeFileSync(inFile, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  let out = '';
  const code = main(['node', 'cli.js', 'tracks', '--in', inFile], (text) => { out += text; });
  assert.equal(code, 0);
  assert.ok(out.includes('"CERTIFICATE"'));
});
