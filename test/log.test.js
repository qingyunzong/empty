import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SegmentLog, recover } from '../src/log.js';
import { truncateAt } from '../src/fault.js';
import { replay } from '../src/verify.js';
import { mulberry32, pick, randInt } from '../src/rng.js';
import { COMMANDS, SENSORS, SENSOR_VALUES, evaluate } from '../src/machine.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'retort-log-'));
}

test('故障点1: 写完 data 未写 commit -> 丢弃该批, 半条命令不生效', () => {
  const dir = tmpdir();
  const log = new SegmentLog(dir);
  log.cmd('LOCK_DOOR');
  log.commit();
  log.cmd('START_HEAT');
  log.ack('PRESSURE', 'LOW');
  const r = log.commit({ fault: 'after-data' });
  assert.equal(r.crashed, true);

  const rec = recover(dir);
  assert.deepEqual(rec.records, [{ type: 'cmd', name: 'LOCK_DOOR' }]);
  assert.deepEqual(rec.segments.map((s) => s.status), ['visible', 'discarded']);
  assert.equal(rec.errors.length, 0);
});

test('故障点2: 写完 commit 未写 manifest -> 整批可见, manifest 重建', () => {
  const dir = tmpdir();
  const log = new SegmentLog(dir);
  log.cmd('LOCK_DOOR');
  log.commit();
  log.cmd('START_HEAT');
  log.ack('PRESSURE', 'OK');
  log.commit({ fault: 'after-commit' });

  const rec = recover(dir);
  assert.equal(rec.records.length, 3);
  assert.deepEqual(rec.segments.map((s) => s.status), ['visible', 'visible']);
  assert.equal(rec.manifestRebuilt, true);
  // 重建后的 manifest 覆盖两段
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.committed, [1, 2]);
});

test('字节截断故障注入 -> ERR_CORRUPT 标识坏段, 其余段不受影响', () => {
  const dir = tmpdir();
  const log = new SegmentLog(dir);
  log.cmd('LOCK_DOOR');
  log.commit();
  log.cmd('START_HEAT');
  log.ack('PRESSURE', 'OK');
  log.commit();

  const dataFile = path.join(dir, 'seg-000002.data');
  const size = fs.statSync(dataFile).size;
  truncateAt(dataFile, size - 10); // 截断 CRC 尾行的一部分

  const rec = recover(dir);
  assert.equal(rec.errors.length, 1);
  assert.equal(rec.errors[0].code, 'ERR_CORRUPT');
  assert.equal(rec.errors[0].segment, 2);
  assert.deepEqual(rec.records, [{ type: 'cmd', name: 'LOCK_DOOR' }]);
});

test('截断到 0 字节同样识别为 ERR_CORRUPT', () => {
  const dir = tmpdir();
  const log = new SegmentLog(dir);
  log.cmd('LOCK_DOOR');
  log.commit();
  truncateAt(path.join(dir, 'seg-000001.data'), 0);
  const rec = recover(dir);
  assert.equal(rec.errors[0].code, 'ERR_CORRUPT');
  assert.equal(rec.records.length, 0);
});

test('验收3: 两类故障点重启后状态可预测且重放相同(seed 一致)', () => {
  for (const seed of [1, 7, 42, 2024]) {
    for (const fault of ['after-data', 'after-commit']) {
      const rng = mulberry32(seed);
      const dir = tmpdir();
      const log = new SegmentLog(dir);
      const expected = [];
      // 第一批: 正常提交
      const n1 = randInt(rng, 1, 4);
      for (let i = 0; i < n1; i++) {
        let e;
        if (rng() < 0.5) {
          e = { type: 'cmd', name: pick(rng, COMMANDS) };
        } else {
          const sensor = pick(rng, SENSORS);
          e = { type: 'ack', sensor, value: pick(rng, SENSOR_VALUES[sensor]) };
        }
        log.append(e);
        expected.push(e);
      }
      log.commit();
      // 第二批: 故障点掉电
      const batch2 = [];
      const n2 = randInt(rng, 1, 4);
      for (let i = 0; i < n2; i++) {
        const e = { type: 'cmd', name: pick(rng, COMMANDS) };
        log.append(e);
        batch2.push(e);
      }
      log.commit({ fault });

      const rec = recover(dir);
      const want = fault === 'after-data' ? expected : [...expected, ...batch2];
      assert.deepEqual(rec.records, want, `seed=${seed} fault=${fault}`);
      // 重放确定性: 恢复记录重放 == 期望历史直接求值
      assert.deepEqual(replay(rec.records).safeState, evaluate(want).safeState);
      assert.equal(replay(rec.records).verdict, evaluate(want).verdict);
    }
  }
});
