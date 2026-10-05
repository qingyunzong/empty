'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBank, ERR } = require('../src/biobank');
const { runCli, stdoutLines } = require('./helpers');

const CONFIG = {
  racks: [{ id: 'r1', zone: '-80', capacity: 2 }],
  defaultQuota: 10,
  agingWeight: 10,
  freezeDelay: 5,
};

const arrive = (time, id, priority = 1) => ({
  type: 'arrive',
  time,
  sample: { id, project: 'p', priority, deadline: 100, zone: '-80' },
});

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biobank-test-'));
}

function writeJsonl(file, events) {
  fs.writeFileSync(file, events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
}

test('invalid events are rejected with typed errors and leave state unchanged', () => {
  const bank = createBank(CONFIG);
  bank.applyStep([arrive(0, 'A')]);
  const before = bank.hash();

  const cases = [
    [{ type: 'bogus', time: 1 }],
    [{ type: 'arrive', time: 1, sample: { id: 'B', project: 'p', priority: 1, zone: '-80' } }],
    [{ type: 'arrive', time: 1, sample: { id: 'A', project: 'p', priority: 1, deadline: 100, zone: '-80' } }],
    [{ type: 'correct', time: 1, sampleId: 'ZZZ', priority: 5 }],
    [{ type: 'cancel', time: 1, sampleId: 'ZZZ' }],
    [{ type: 'correct', time: 1, sampleId: 'A' }],
  ];
  for (const events of cases) {
    assert.throws(() => bank.applyStep(events), (err) => err.code === ERR.INVALID_EVENT);
    assert.equal(bank.hash(), before, `state unchanged after ${JSON.stringify(events)}`);
  }
  assert.throws(() => bank.applyStep([{ type: 'undo', time: 1, to: 99 }]), (err) => err.code === ERR.INVALID_UNDO);
  assert.equal(bank.hash(), before);
});

test('time regression is rejected and leaves state unchanged', () => {
  const bank = createBank(CONFIG);
  bank.applyStep([arrive(5, 'A')]);
  const before = bank.hash();
  assert.throws(() => bank.applyStep([arrive(3, 'B')]), (err) => err.code === ERR.TIME_REGRESSION);
  assert.equal(bank.hash(), before);
});

test('capacity overflow is rejected and leaves state unchanged', () => {
  const bank = createBank({ ...CONFIG, maxActiveSamples: 1 });
  bank.applyStep([arrive(0, 'A')]);
  const before = bank.hash();
  assert.throws(() => bank.applyStep([arrive(1, 'B')]), (err) => err.code === ERR.CAPACITY_OVERFLOW);
  assert.equal(bank.hash(), before);
  assert.deepEqual(bank.certState().placed.map((p) => p.id), ['A']);
});

test('CLI exits 2 with JSON error on stderr for invalid events, time regression and capacity overflow', () => {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ ...CONFIG, maxActiveSamples: 2 }));

  let evPath = path.join(dir, 'bad-json.jsonl');
  writeJsonl(evPath, ['{"type":"arrive",']);
  let res = runCli(['--config', cfgPath, '--events', evPath]);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).error.code, 'INVALID_EVENT');

  evPath = path.join(dir, 'bad-type.jsonl');
  writeJsonl(evPath, [{ type: 'explode', time: 0 }]);
  res = runCli(['--config', cfgPath, '--events', evPath]);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).error.code, 'INVALID_EVENT');

  evPath = path.join(dir, 'regression.jsonl');
  writeJsonl(evPath, [arrive(5, 'A'), arrive(3, 'B')]);
  res = runCli(['--config', cfgPath, '--events', evPath]);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).error.code, 'TIME_REGRESSION');

  evPath = path.join(dir, 'overflow.jsonl');
  writeJsonl(evPath, [arrive(0, 'A'), arrive(1, 'B'), arrive(2, 'C')]);
  res = runCli(['--config', cfgPath, '--events', evPath]);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).error.code, 'CAPACITY_OVERFLOW');
});

test('crash during log write: restart rejects the half-written record', () => {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  const logPath = path.join(dir, 'bank.log');
  fs.writeFileSync(cfgPath, JSON.stringify(CONFIG));

  const ev1 = path.join(dir, 'events1.jsonl');
  writeJsonl(ev1, [arrive(0, 'A'), arrive(1, 'B')]);
  let res = runCli(['--config', cfgPath, '--events', ev1, '--log', logPath]);
  assert.equal(res.status, 0, res.stderr);
  const firstRun = stdoutLines(res);
  assert.equal(firstRun.length, 2);
  const logLines = () => fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(logLines().length, 2);

  // Simulate a crash in the middle of writing the third record.
  const third = logLines()[0].slice(0, 40);
  fs.appendFileSync(logPath, third);

  const ev2 = path.join(dir, 'events2.jsonl');
  writeJsonl(ev2, [arrive(2, 'C')]);
  res = runCli(['--config', cfgPath, '--events', ev2, '--log', logPath]);
  assert.equal(res.status, 0, res.stderr);
  const warning = JSON.parse(res.stderr.trim());
  assert.equal(warning.warning.code, 'LOG_CORRUPTED');
  assert.equal(warning.warning.line, 3);

  const secondRun = stdoutLines(res);
  assert.equal(secondRun.length, 1);
  assert.equal(secondRun[0].step, 3, 'new record continues after the valid prefix');
  assert.equal(secondRun[0].eventPoint, 3, 'only the two valid records plus the new event are applied');

  const bank = createBank(CONFIG);
  bank.applyStep([arrive(0, 'A')]);
  bank.applyStep([arrive(1, 'B')]);
  const expectedHash = bank.applyStep([arrive(2, 'C')]).hash;
  assert.equal(secondRun[0].hash, expectedHash, 'recovered state equals a clean replay');

  assert.equal(logLines().length, 3);
  for (const line of logLines()) JSON.parse(line);

  const ev3 = path.join(dir, 'events3.jsonl');
  writeJsonl(ev3, [arrive(3, 'D')]);
  res = runCli(['--config', cfgPath, '--events', ev3, '--log', logPath]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr.trim(), '');
  assert.equal(stdoutLines(res)[0].eventPoint, 4);
});

test('log record with a corrupted checksum is rejected on restart', () => {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  const logPath = path.join(dir, 'bank.log');
  fs.writeFileSync(cfgPath, JSON.stringify(CONFIG));

  const ev1 = path.join(dir, 'events1.jsonl');
  writeJsonl(ev1, [arrive(0, 'A'), arrive(1, 'B')]);
  let res = runCli(['--config', cfgPath, '--events', ev1, '--log', logPath]);
  assert.equal(res.status, 0, res.stderr);

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[1]);
  rec.hash = (rec.hash[0] === 'a' ? 'b' : 'a') + rec.hash.slice(1);
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(logPath, lines.join('\n') + '\n');

  const ev2 = path.join(dir, 'events2.jsonl');
  writeJsonl(ev2, [arrive(2, 'C')]);
  res = runCli(['--config', cfgPath, '--events', ev2, '--log', logPath]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stderr.trim()).warning.code, 'LOG_CORRUPTED');
  assert.equal(stdoutLines(res)[0].eventPoint, 2, 'corrupted record and everything after it is discarded');
});
