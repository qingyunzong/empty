import test from 'node:test';
import assert from 'node:assert/strict';
import { processText } from '../cli.js';

test('CLI processes JSONL commands end to end', () => {
  const cmds = [
    { cmd: 'shiftTable', id: 'st1', offsets: [
      { start: 0, end: 100, offset: 0 },
      { start: 100, end: 200, offset: 10 },
    ] },
    { cmd: 'rule', id: 'r1', device: 'd1', periodStart: 0, periodLength: 50,
      expectedOffset: 5, grace: 10, shiftTable: 'st1' },
    { cmd: 'heartbeat', id: 'h1', device: 'd1', time: 6 },
    { cmd: 'heartbeat', id: 'h2', device: 'd1', time: 60 },
    { cmd: 'cutoff', time: 130 },
    { cmd: 'scan' },
  ];
  const input = '# comment line\n\n' + cmds.map(JSON.stringify).join('\n') + '\n';
  const { records, hadError } = processText(input);
  assert.equal(hadError, false);
  const alarms = records.filter((l) => l.type === 'alarms');
  assert.equal(alarms.length, 1);
  assert.deepEqual(alarms[0].alarms, [
    { start: 115, end: 130, status: 'OPEN', missedPeriods: [2] },
  ]);
  assert.equal(alarms[0].certificate.periodCount, 3);
});

test('CLI emits correction records and error lines, exit code reflects errors', () => {
  const ok = processText([
    { cmd: 'rule', id: 'r', device: 'd', periodStart: 0, periodLength: 10, grace: 2, mergeGap: 20 },
    { cmd: 'heartbeat', id: 'h1', device: 'd', time: 70 },
    { cmd: 'cutoff', time: 100 },
    { cmd: 'retract', id: 'h1' },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal(ok.hadError, false);
  const corr = ok.records.find((l) => l.type === 'correction');
  assert.ok(corr);
  assert.equal(corr.affected[0].version, 2);

  const bad = processText([
    JSON.stringify({ cmd: 'rule', id: 'r', device: 'd', periodStart: 0, periodLength: 0 }),
    'this is not json',
  ].join('\n'));
  assert.equal(bad.hadError, true);
  const errs = bad.records.filter((l) => l.type === 'error');
  assert.deepEqual(errs.map((e) => e.error), ['ZERO_PERIOD', 'BAD_JSON']);
});
