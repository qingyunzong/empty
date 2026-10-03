'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CorrectionLog, CorrectionError } = require('../src/correction-log');

const OBS = [
  { id: 'a', value: 1 },
  { id: 'b', value: 10 },
];

function makeCorrections(n) {
  const corrections = [];
  for (let i = 0; i < n; i += 1) {
    corrections.push({
      timestamp: 100 + i,
      reason: `R${i + 1}`,
      author: `author${i + 1}`,
      observationId: i % 2 === 0 ? 'a' : 'b',
      after: 1000 + i,
    });
  }
  return corrections;
}

function buildLog(n) {
  const log = new CorrectionLog(OBS.map((o) => ({ ...o })));
  for (const c of makeCorrections(n)) log.apply(c);
  return log;
}

function referenceState(log) {
  const values = new Map(OBS.map((o) => [o.id, o.value]));
  for (let i = 0; i < log.cursor; i += 1) {
    for (const change of log.entries[i].changes) {
      values.set(change.observationId, change.after);
    }
  }
  return [...values.entries()]
    .map(([id, value]) => ({ id, value }))
    .sort((x, y) => (x.id < y.id ? -1 : 1));
}

test('连续更正后撤销与重做', () => {
  const log = buildLog(3);
  assert.deepEqual(log.state(), [
    { id: 'a', value: 1002 },
    { id: 'b', value: 1001 },
  ]);
  assert.equal(log.undo(), true);
  assert.equal(log.undo(), true);
  assert.deepEqual(log.state(), [
    { id: 'a', value: 1000 },
    { id: 'b', value: 10 },
  ]);
  assert.equal(log.redo(), true);
  assert.equal(log.redo(), true);
  assert.deepEqual(log.state(), [
    { id: 'a', value: 1002 },
    { id: 'b', value: 1001 },
  ]);
  assert.equal(log.redo(), false);
});

test('撤销只逆置游标之前的更正，新增更正截断重做分支', () => {
  const log = buildLog(3);
  log.undo();
  log.undo();
  log.apply({
    timestamp: 200,
    reason: 'R-NEW',
    author: 'chen',
    observationId: 'a',
    after: 7777,
  });
  assert.equal(log.entries.length, 2);
  assert.equal(log.cursor, 2);
  assert.equal(log.redo(), false);
  assert.deepEqual(log.state(), [
    { id: 'a', value: 7777 },
    { id: 'b', value: 10 },
  ]);
  log.undo();
  assert.deepEqual(log.state(), [
    { id: 'a', value: 1000 },
    { id: 'b', value: 10 },
  ]);
});

test('压缩等效性：最终值、编号映射、状态哈希一致，原因码保留', () => {
  const before = buildLog(4);
  const hashBefore = before.stateHash();
  const stateBefore = before.state();

  const after = buildLog(4);
  const compacted = after.compact(2, 3);

  assert.deepEqual(after.state(), stateBefore);
  assert.equal(after.stateHash(), hashBefore);
  assert.deepEqual(compacted.mergedFrom, ['C2', 'C3']);
  assert.deepEqual(after.idMap, { C2: compacted.id, C3: compacted.id });
  assert.deepEqual(compacted.reasons, ['R2', 'R3']);
  assert.deepEqual(after.compactions[0].mergedSeqs, [2, 3]);

  after.undo();
  after.redo();
  assert.equal(after.stateHash(), hashBefore);

  const plain = buildLog(4);
  plain.compact(1, 4);
  assert.equal(plain.entries.length, 1);
  assert.deepEqual(plain.entries[0].reasons, ['R1', 'R2', 'R3', 'R4']);
  assert.equal(plain.stateHash(), hashBefore);
});

test('非法区间与错误输入', () => {
  const log = buildLog(3);
  log.undo();
  assert.throws(() => log.compact(2, 3), (err) => {
    assert.ok(err instanceof CorrectionError);
    assert.equal(err.code, 'UNDONE_IN_RANGE');
    return true;
  });
  assert.throws(() => log.compact(0, 1), { code: 'BAD_RANGE' });
  assert.throws(() => log.compact(2, 99), { code: 'BAD_RANGE' });

  assert.throws(
    () => buildLog(1).apply({ timestamp: 200, reason: 'R', author: 'x', observationId: 'nope', after: 1 }),
    { code: 'UNKNOWN_OBSERVATION' },
  );
  const reversed = new CorrectionLog(OBS.map((o) => ({ ...o })));
  reversed.apply({ timestamp: 50, reason: 'R', author: 'x', observationId: 'a', after: 2 });
  assert.throws(
    () => reversed.apply({ timestamp: 49, reason: 'R', author: 'x', observationId: 'a', after: 3 }),
    { code: 'OUT_OF_ORDER_TIMESTAMP' },
  );
});

test('不超过 4 条更正：枚举所有撤销/重做序列并比对最终状态', () => {
  for (let n = 1; n <= 4; n += 1) {
    const maxLen = 7;
    const total = 1 << maxLen;
    for (let mask = 0; mask < total; mask += 1) {
      const log = buildLog(n);
      for (let step = 0; step < maxLen; step += 1) {
        if ((mask >> step) & 1) log.redo();
        else log.undo();
      }
      assert.deepEqual(
        log.state(),
        referenceState(log),
        `n=${n} mask=${mask.toString(2)} cursor=${log.cursor}`,
      );
      assert.equal(log.stateHash(), referenceHash(log));
    }
    for (let k = 0; k <= n; k += 1) {
      const log = buildLog(n);
      for (let i = 0; i < k; i += 1) log.undo();
      assert.deepEqual(log.state(), referenceState(log));
    }
  }
});

function referenceHash(log) {
  const { hashState } = require('../src/correction-log');
  return hashState(referenceState(log).map((o) => [o.id, o.value]));
}

test('CLI：正常输出与错误退出码 1', () => {
  const { run } = require('../cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-cli-'));
  const obsPath = path.join(dir, 'observations.json');
  const corrPath = path.join(dir, 'corrections.json');
  const statePath = path.join(dir, 'state.json');
  const historyPath = path.join(dir, 'history.json');
  fs.writeFileSync(obsPath, JSON.stringify(OBS));
  fs.writeFileSync(corrPath, JSON.stringify(makeCorrections(3)));
  const silent = { log: () => {}, error: () => {} };

  const okCode = run(
    [obsPath, corrPath, '--state', statePath, '--history', historyPath, '--compact', '1:2'],
    silent,
  );
  assert.equal(okCode, 0);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  assert.equal(state.stateHash, history.stateHash);
  assert.deepEqual(history.idMap, { C1: 'C4', C2: 'C4' });
  assert.deepEqual(history.entries[0].reasons, ['R1', 'R2']);

  fs.writeFileSync(
    corrPath,
    JSON.stringify([{ timestamp: 1, reason: 'R', author: 'x', observationId: 'ghost', after: 1 }]),
  );
  const errors = [];
  const badCode = run([obsPath, corrPath, '--state', statePath, '--history', historyPath], {
    log: () => {},
    error: (m) => errors.push(m),
  });
  assert.equal(badCode, 1);
  assert.match(errors[0], /UNKNOWN_OBSERVATION/);

  fs.writeFileSync(corrPath, JSON.stringify(makeCorrections(2)));
  errors.length = 0;
  const badRangeCode = run(
    [obsPath, corrPath, '--state', statePath, '--history', historyPath, '--compact', '1:9'],
    { log: () => {}, error: (m) => errors.push(m) },
  );
  assert.equal(badRangeCode, 1);
  assert.match(errors[0], /BAD_RANGE/);

  fs.writeFileSync(
    corrPath,
    JSON.stringify([
      { timestamp: 10, reason: 'R', author: 'x', observationId: 'a', after: 2 },
      { timestamp: 9, reason: 'R', author: 'x', observationId: 'a', after: 3 },
    ]),
  );
  errors.length = 0;
  const reversedCode = run([obsPath, corrPath, '--state', statePath, '--history', historyPath], {
    log: () => {},
    error: (m) => errors.push(m),
  });
  assert.equal(reversedCode, 1);
  assert.match(errors[0], /OUT_OF_ORDER_TIMESTAMP/);
});
