import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { ToolingSystem } from '../src/system.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-store-'));
}

function systemWithOrder() {
  const sys = new ToolingSystem();
  sys.command({
    cmd: 'addMold', id: 'M1', cycleMinutes: 100, maintenanceMinutes: 20,
    usedMinutes: 0, calendar: [{ start: 0, end: 100000 }],
  });
  sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 30 });
  return sys;
}

test('正常提交：临时文件 rename 后状态可加载', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'state.json');
  const store = new JsonStore(file);
  const sys = systemWithOrder();
  store.commit(sys.state);
  assert.ok(store.exists());
  assert.ok(!fs.existsSync(store.tmpPath), '临时文件已被 rename 消费');
  const loaded = new ToolingSystem(store.load());
  assert.deepEqual(loaded.state, sys.state);
});

test('故障点 beforeTempWrite：状态文件未被触碰', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'state.json');
  const store = new JsonStore(file, {
    beforeTempWrite: () => { throw new Error('crash before temp write'); },
  });
  assert.throws(() => store.commit(systemWithOrder().state), /crash before temp write/);
  assert.ok(!store.exists(), '从未提交过，状态文件不存在');
  assert.ok(!fs.existsSync(store.tmpPath), '临时文件未残留');
});

test('故障点 beforeRename：旧文件完整可打开，恢复后可再提交', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'state.json');
  let crash = false;
  const store = new JsonStore(file, {
    beforeRename: () => { if (crash) throw new Error('crash before rename'); },
  });
  // 第一笔：基线提交成功
  const sys = systemWithOrder();
  store.commit(sys.state);
  const baselineRaw = fs.readFileSync(file, 'utf8');
  // 第二笔：内存中继续推进，但 rename 前崩溃
  sys.command({ cmd: 'reserve', orderId: 'O2', durationMinutes: 40 });
  crash = true;
  assert.throws(() => store.commit(sys.state), /crash before rename/);
  // 旧文件仍可打开且内容不变 —— 无半笔事务
  assert.equal(fs.readFileSync(file, 'utf8'), baselineRaw);
  const onDisk = new ToolingSystem(store.load());
  assert.deepEqual(Object.keys(onDisk.state.orders), ['O1']);
  assert.ok(!fs.existsSync(store.tmpPath), '临时文件已清理');
  // 恢复：去掉故障后同一状态可成功提交
  crash = false;
  store.commit(sys.state);
  const recovered = new ToolingSystem(store.load());
  assert.deepEqual(Object.keys(recovered.state.orders).sort(), ['O1', 'O2']);
});

test('故障点 afterTempWrite：临时文件已落盘但未生效，旧文件不变', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'state.json');
  let crash = false;
  const store = new JsonStore(file, {
    afterTempWrite: () => { if (crash) throw new Error('crash after temp write'); },
  });
  const sys = systemWithOrder();
  store.commit(sys.state);
  const baselineRaw = fs.readFileSync(file, 'utf8');
  sys.command({ cmd: 'cancel', orderId: 'O1' });
  crash = true;
  assert.throws(() => store.commit(sys.state), /crash after temp write/);
  assert.equal(fs.readFileSync(file, 'utf8'), baselineRaw);
  assert.ok(!fs.existsSync(store.tmpPath));
});

test('load 忽略残留的 .tmp 文件', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'state.json');
  const store = new JsonStore(file);
  const sys = systemWithOrder();
  store.commit(sys.state);
  fs.writeFileSync(store.tmpPath, '{"corrupted": true'); // 模拟崩溃残留的临时文件
  const loaded = new ToolingSystem(store.load());
  assert.deepEqual(loaded.state, sys.state);
});
