import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runCli, makeEvent, referenceScan, walBytes, HEADER_SIZE } from './helpers.js';
import { EventStore } from '../src/store.js';
import { crc32 } from '../src/crc32.js';
import { ExitCode } from '../src/errors.js';

// ---------------------------------------------------------------------------
// 验收 1: 正常写入三事件后重启,按 deviceId+seq 查询结果一致且重复写入失败
// ---------------------------------------------------------------------------
test('acceptance 1: append 3 events, restart, query by deviceId+seq, duplicate rejected', () => {
  const dir = tmpdir();
  const events = [makeEvent(0), makeEvent(1), makeEvent(2)];

  for (const event of events) {
    const res = runCli(['append', '--dir', dir], event);
    assert.equal(res.code, ExitCode.OK, res.stderr);
    assert.equal(res.json.ok, true);
    assert.equal(typeof res.json.seq, 'number');
  }

  // 重启 = 全新进程,重新打开同一目录(触发恢复 + 索引重建)
  for (const event of events) {
    const res = runCli(['query', '--dir', dir], { deviceId: event.deviceId, seq: event.seq });
    assert.equal(res.code, ExitCode.OK, res.stderr);
    assert.equal(res.json.ok, true);
    assert.deepEqual(res.json.event, event);
  }

  const byId = runCli(['get', '--dir', dir], { eventId: 'evt-1' });
  assert.equal(byId.code, ExitCode.OK);
  assert.deepEqual(byId.json.event, events[1]);

  // 重复 eventId -> E_DUP, exit code 2
  const dup = runCli(['append', '--dir', dir], events[1]);
  assert.equal(dup.code, ExitCode.E_DUP);
  assert.equal(dup.json.ok, false);
  assert.equal(dup.json.error, 'E_DUP');

  // 重启后重复写入仍然失败(索引由 WAL 恢复重建,非内存状态)
  const dupAfterRestart = runCli(['append', '--dir', dir], events[0]);
  assert.equal(dupAfterRestart.code, ExitCode.E_DUP);
  assert.equal(dupAfterRestart.json.error, 'E_DUP');
});

// ---------------------------------------------------------------------------
// 验收 2: 三类故障点注入,恢复结果严格符合持久性边界
//   after_data / after_sync -> 事件不得可见
//   after_commit            -> 事件必须可见
// ---------------------------------------------------------------------------
test('acceptance 2: fault injection durability boundaries', () => {
  const cases = [
    { fault: 'after_data', visible: false },
    { fault: 'after_sync', visible: false },
    { fault: 'after_commit', visible: true },
  ];
  for (const { fault, visible } of cases) {
    const dir = tmpdir();
    const base = runCli(['append', '--dir', dir], makeEvent(0));
    assert.equal(base.code, ExitCode.OK);

    const crashed = makeEvent(1);
    const res = runCli(['crash', '--dir', dir, '--fault', fault], { event: crashed });
    assert.equal(res.code, ExitCode.E_CRASH, `${fault}: exit code`);
    assert.equal(res.json.error, 'E_CRASH');
    assert.equal(res.json.fault, fault);

    const rec = runCli(['recover', '--dir', dir]);
    assert.equal(rec.code, ExitCode.OK);
    assert.equal(rec.json.records, visible ? 2 : 1, `${fault}: recovered records`);

    const got = runCli(['get', '--dir', dir], { eventId: crashed.eventId });
    if (visible) {
      assert.equal(got.code, ExitCode.OK, `${fault}: must be visible`);
      assert.deepEqual(got.json.event, crashed);
    } else {
      assert.equal(got.code, ExitCode.E_NOTFOUND, `${fault}: must NOT be visible`);
      assert.equal(got.json.error, 'E_NOTFOUND');
    }

    // 恢复后仍可继续写入,且可见性结论在再次重启后保持稳定
    const next = runCli(['append', '--dir', dir], makeEvent(2));
    assert.equal(next.code, ExitCode.OK);
    const again = runCli(['get', '--dir', dir], { eventId: crashed.eventId });
    assert.equal(again.code, visible ? ExitCode.OK : ExitCode.E_NOTFOUND);
  }
});

// ---------------------------------------------------------------------------
// 验收 3: <=6 条记录的所有故障前缀枚举,与朴素参考算法一致
//   参考算法: 只保留含有效提交标记的最长前缀
// ---------------------------------------------------------------------------
class SimulatedCrash extends Error {}

function crashAppend(store, event, fault) {
  assert.throws(
    () => store.append(event, {
      fault,
      onFault: () => { throw new SimulatedCrash(fault); },
    }),
    SimulatedCrash,
  );
}

function allEvents(store) {
  return [...store.byId.values()].sort((a, b) => a.eventId.localeCompare(b.eventId));
}

test('acceptance 3: fault-prefix enumeration for <=6 records matches reference algorithm', () => {
  const faults = ['after_data', 'after_sync', 'after_commit'];
  for (let n = 0; n <= 6; n += 1) {
    for (const fault of faults) {
      const dir = tmpdir();
      // n 条已提交记录
      let store = new EventStore(dir).open();
      for (let i = 0; i < n; i += 1) store.append(makeEvent(i));
      // 第 n+1 条在指定故障点崩溃
      crashAppend(store, makeEvent(n), fault);
      store.close();

      // 崩溃后、恢复前:用朴素参考算法扫描原始字节
      const expected = referenceScan(walBytes(dir));

      // 重新打开 = 崩溃恢复 + 索引重建
      store = new EventStore(dir).open();
      const actual = allEvents(store);
      const expectedEvents = expected.events
        .slice()
        .sort((a, b) => a.eventId.localeCompare(b.eventId));
      assert.deepEqual(actual, expectedEvents, `n=${n} fault=${fault}`);
      assert.equal(fs.statSync(path.join(dir, 'wal.log')).size, expected.validBytes);

      const crashedVisible = fault === 'after_commit';
      assert.equal(actual.length, crashedVisible ? n + 1 : n, `n=${n} fault=${fault}`);
      if (crashedVisible) {
        assert.deepEqual(store.get(`evt-${n}`), makeEvent(n));
      } else {
        assert.throws(() => store.get(`evt-${n}`), /E_NOTFOUND|unknown eventId/);
      }
      store.close();
    }
  }
});

// ---------------------------------------------------------------------------
// 验收 3 补充: 尾部损坏(垃圾字节 / CRC 错误 / 截断头 / 截断负载 /
// 未提交帧)一律按不完整截断,结果与参考算法一致
// ---------------------------------------------------------------------------
test('acceptance 3b: corrupt tails are truncated, matching reference algorithm', () => {
  const corruptions = {
    garbage_bytes: (dir) => {
      fs.appendFileSync(path.join(dir, 'wal.log'), Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]));
    },
    bad_crc: (dir) => {
      const payload = Buffer.from(JSON.stringify(makeEvent(99)), 'utf8');
      const header = Buffer.alloc(HEADER_SIZE);
      header.writeUInt32LE(payload.length, 0);
      header.writeUInt32LE(crc32(payload) ^ 0xffffffff, 4); // 翻转 CRC
      header.writeUInt32LE(99, 8);
      header.writeUInt8(1, 12);
      fs.appendFileSync(path.join(dir, 'wal.log'), Buffer.concat([header, payload]));
    },
    truncated_header: (dir) => {
      fs.appendFileSync(path.join(dir, 'wal.log'), Buffer.from([0x10, 0x00, 0x00]));
    },
    truncated_payload: (dir) => {
      const payload = Buffer.from(JSON.stringify(makeEvent(98)), 'utf8');
      const header = Buffer.alloc(HEADER_SIZE);
      header.writeUInt32LE(payload.length, 0);
      header.writeUInt32LE(crc32(payload), 4);
      header.writeUInt32LE(98, 8);
      header.writeUInt8(1, 12);
      fs.appendFileSync(path.join(dir, 'wal.log'), Buffer.concat([header, payload.subarray(0, 5)]));
    },
    uncommitted_frame: (dir) => {
      const payload = Buffer.from(JSON.stringify(makeEvent(97)), 'utf8');
      const header = Buffer.alloc(HEADER_SIZE);
      header.writeUInt32LE(payload.length, 0);
      header.writeUInt32LE(crc32(payload), 4);
      header.writeUInt32LE(97, 8);
      header.writeUInt8(0, 12); // 提交标记未置位
      fs.appendFileSync(path.join(dir, 'wal.log'), Buffer.concat([header, payload]));
    },
  };

  for (let n = 0; n <= 6; n += 1) {
    for (const [name, corrupt] of Object.entries(corruptions)) {
      const dir = tmpdir();
      let store = new EventStore(dir).open();
      for (let i = 0; i < n; i += 1) store.append(makeEvent(i));
      store.close();

      corrupt(dir);
      const expected = referenceScan(walBytes(dir));

      store = new EventStore(dir).open();
      const actual = allEvents(store);
      assert.deepEqual(
        actual,
        expected.events.slice().sort((a, b) => a.eventId.localeCompare(b.eventId)),
        `n=${n} corruption=${name}`,
      );
      assert.equal(actual.length, n, `n=${n} corruption=${name}`);
      assert.equal(fs.statSync(path.join(dir, 'wal.log')).size, expected.validBytes);
      assert.ok(store.lastRecovery.truncatedBytes > 0, `n=${n} corruption=${name}: must truncate`);
      store.close();

      // 截断后文件可继续追加,新事件紧接有效前缀
      store = new EventStore(dir).open();
      store.append(makeEvent(1000 + n));
      store.close();
      store = new EventStore(dir).open();
      assert.equal(allEvents(store).length, n + 1);
      store.close();
    }
  }
});
