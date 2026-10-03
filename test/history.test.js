'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  History, HistoryError, serializeBlock, parseBlocks,
} = require('../lib/history.js');
const { run: cliRun } = require('../cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hist-test-'));
}

// 捕获 stderr 的 open
function openCapturing(dir) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { chunks.push(String(s)); return true; };
  try {
    return { h: History.open(dir), stderr: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

// 验收 1：枚举小图全部拓扑序，对照 isAncestor
test('全部拓扑序与 isAncestor 互相印证', () => {
  const dir = tmpdir();
  const h = History.init(dir);
  // 小图：root；A<-root；B<-root；C<-A；D<-B,C
  const root = h.append({ author: 'a', payload: 'root' });
  const A = h.append({ author: 'a', payload: 'A', parents: [root] });
  const B = h.append({ author: 'b', payload: 'B', parents: [root] });
  const C = h.append({ author: 'a', payload: 'C', parents: [A] });
  const D = h.append({ author: 'b', payload: 'D', parents: [B, C] });

  const ids = [root, A, B, C, D];
  const parents = new Map(ids.map((id) => [id, h.getEvent(id).parents]));

  // 测试内独立实现：DFS 传递闭包求祖先关系
  const closureAncestor = (a, b) => {
    const seen = new Set();
    const stack = [...parents.get(b)];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === a) return true;
      if (!seen.has(cur)) { seen.add(cur); stack.push(...parents.get(cur)); }
    }
    return false;
  };
  // 全对对照
  for (const x of ids) {
    for (const y of ids) {
      assert.equal(h.isAncestor(x, y), closureAncestor(x, y), `isAncestor(${x},${y})`);
    }
  }
  assert.equal(h.isAncestor(root, root), false, '祖先关系是严格的');

  // 测试内独立实现：回溯枚举全部拓扑序
  const allOrders = [];
  const indeg = new Map(ids.map((id) => [id, parents.get(id).length]));
  const kids = new Map(ids.map((id) => [id, []]));
  for (const id of ids) for (const p of parents.get(id)) kids.get(p).push(id);
  const walk = (prefix) => {
    if (prefix.length === ids.length) { allOrders.push(prefix); return; }
    for (const id of ids) {
      if (indeg.get(id) === 0 && !prefix.includes(id)) {
        indeg.set(id, -1);
        for (const k of kids.get(id)) indeg.set(k, indeg.get(k) - 1);
        walk([...prefix, id]);
        for (const k of kids.get(id)) indeg.set(k, indeg.get(k) + 1);
        indeg.set(id, 0);
      }
    }
  };
  walk([]);
  assert.ok(allOrders.length > 1, '该图存在多个拓扑序');

  for (const order of allOrders) {
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const x of ids) {
      for (const y of ids) {
        if (h.isAncestor(x, y)) {
          assert.ok(pos.get(x) < pos.get(y), '祖先必须排在后代之前');
        } else if (x !== y && !h.isAncestor(y, x)) {
          // 并发对：两种相对顺序都合法，不约束
        }
        // 逆命题：拓扑序中靠后者绝不是靠前者的祖先
        if (pos.get(y) > pos.get(x)) {
          assert.equal(h.isAncestor(y, x), false, '拓扑序靠后者不能是靠前者的祖先');
        }
      }
    }
  }
  // 已知关系抽查：root 是所有人的祖先；A 与 B 并发；C 与 B 并发
  for (const id of [A, B, C, D]) assert.ok(h.isAncestor(root, id));
  assert.ok(h.areConcurrent(A, B));
  assert.ok(h.areConcurrent(C, B));
  assert.ok(!h.areConcurrent(root, D));
});

// 验收 2：钻石并发合并确定性（与输入顺序无关、幂等、跨副本一致）
test('钻石并发合并产生确定性 head', () => {
  // 两个独立副本离线重演相同更正（同作者同计数器 => 同 id）
  const build = () => {
    const dir = tmpdir();
    const h = History.init(dir);
    const root = h.append({ author: 'a', payload: 'root' });
    const L = h.append({ author: 'x', payload: 'left', parents: [root] });
    const R = h.append({ author: 'y', payload: 'right', parents: [root] });
    return { dir, h, root, L, R };
  };
  const r1 = build();
  const r2 = build();
  assert.equal(r1.L, r2.L, '相同更正事件 id 确定性一致');
  assert.ok(r1.h.areConcurrent(r1.L, r1.R), '钻石两臂并发');

  const m1 = r1.h.merge(r1.L, r1.R);
  const m2 = r2.h.merge(r2.R, r2.L); // 输入顺序颠倒
  assert.equal(m1, m2, 'merge(a,b) === merge(b,a)');
  assert.notEqual(m1, r1.L);
  assert.notEqual(m1, r1.R);
  assert.deepEqual(r1.h.heads(), [m1], '合并后只剩一个 head');
  assert.deepEqual(r2.h.heads(), [m1]);

  // 幂等：再次合并不产生新块
  const before = fs.readFileSync(path.join(r1.dir, 'events.log'), 'utf8');
  assert.equal(r1.h.merge(r1.R, r1.L), m1);
  assert.equal(fs.readFileSync(path.join(r1.dir, 'events.log'), 'utf8'), before);

  // 因果关系：两臂都是合并 head 的祖先，两臂互不祖先
  assert.ok(r1.h.isAncestor(r1.L, m1));
  assert.ok(r1.h.isAncestor(r1.R, m1));
  assert.ok(!r1.h.isAncestor(r1.L, r1.R));
  assert.ok(!r1.h.isAncestor(r1.R, r1.L));

  // 一方已是另一方祖先时，merge 直接返回后代，不产生新事件
  const m3 = r1.h.merge(r1.L, m1);
  assert.equal(m3, m1);

  // 重新打开后结果一致（持久化确定性）
  const { h: reopened } = openCapturing(r1.dir);
  assert.deepEqual(reopened.heads(), [m1]);
});

// 验收 3：成环与缺父拒绝
test('成环与缺父被拒绝', () => {
  // 缺父
  {
    const dir = tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    const ev = {
      id: 'e'.repeat(64), type: 'event', parents: ['f'.repeat(64)],
      author: 'a', counter: 1, payloadB64: '',
    };
    fs.writeFileSync(path.join(dir, 'events.log'), serializeBlock(ev));
    assert.throws(() => History.open(dir), (err) => {
      assert.ok(err instanceof HistoryError);
      assert.equal(err.code, 'ERR_MISSING_PARENT');
      return true;
    });
  }
  // 成环：X<-Y, Y<-X
  {
    const dir = tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    const X = { id: '1'.repeat(64), type: 'event', parents: ['2'.repeat(64)], author: 'a', counter: 1, payloadB64: '' };
    const Y = { id: '2'.repeat(64), type: 'event', parents: ['1'.repeat(64)], author: 'a', counter: 2, payloadB64: '' };
    fs.writeFileSync(path.join(dir, 'events.log'), serializeBlock(X) + serializeBlock(Y));
    assert.throws(() => History.open(dir), (err) => {
      assert.equal(err.code, 'ERR_CYCLE');
      return true;
    });
  }
  // append 指定未知父 => ERR_MISSING_PARENT
  {
    const dir = tmpdir();
    const h = History.init(dir);
    assert.throws(() => h.append({ author: 'a', payload: 'x', parents: ['0'.repeat(64)] }),
      (err) => err.code === 'ERR_MISSING_PARENT');
  }
  // CRC 损坏 => ERR_CORRUPT
  {
    const dir = tmpdir();
    const h = History.init(dir);
    h.append({ author: 'a', payload: 'x' });
    const f = path.join(dir, 'events.log');
    const text = fs.readFileSync(f, 'utf8').replace('counter=1', 'counter=9');
    fs.writeFileSync(f, text);
    assert.throws(() => History.open(dir), (err) => err.code === 'ERR_CORRUPT');
  }
});

// 验收 4：删非叶子报 ERR_CONFLICT；删叶子保留墓碑
test('删除非叶子报 ERR_CONFLICT，删叶子保留墓碑块', () => {
  const dir = tmpdir();
  const h = History.init(dir);
  const root = h.append({ author: 'a', payload: 'root' });
  const leaf = h.append({ author: 'a', payload: 'leaf', parents: [root] });

  assert.throws(() => h.remove(root), (err) => {
    assert.ok(err instanceof HistoryError);
    assert.equal(err.code, 'ERR_CONFLICT');
    return true;
  });
  // 未知 id => ERR_HEAD
  assert.throws(() => h.remove('9'.repeat(64)), (err) => err.code === 'ERR_HEAD');

  const tomb = h.remove(leaf);
  assert.deepEqual(h.heads(), [root], '删除叶子后其父回到 heads');
  assert.equal(h.getEvent(leaf), null, '事件已删除');
  assert.throws(() => h.checkout(leaf), (err) => err.code === 'ERR_HEAD');

  // 墓碑块仍在日志中，重开后依然可见且父引用校验通过
  const blocks = parseBlocks(fs.readFileSync(path.join(dir, 'events.log'), 'utf8'));
  const tombs = blocks.filter((b) => b.type === 'tombstone');
  assert.equal(tombs.length, 1);
  assert.equal(tombs[0].deleted, leaf);
  assert.equal(tombs[0].id, tomb);
  const { h: reopened } = openCapturing(dir);
  assert.deepEqual(reopened.heads(), [root]);
  // 以被删事件为父追加 => ERR_MISSING_PARENT
  assert.throws(() => reopened.append({ author: 'b', payload: 'z', parents: [leaf] }),
    (err) => err.code === 'ERR_MISSING_PARENT');
});

// 验收 5：heads / 索引损坏可按事件图重建并报告
test('heads 与索引损坏时以事件图重建并报告', () => {
  const dir = tmpdir();
  const h = History.init(dir);
  const root = h.append({ author: 'a', payload: 'root' });
  const L = h.append({ author: 'x', payload: 'L', parents: [root] });
  const R = h.append({ author: 'y', payload: 'R', parents: [root] });
  const wantHeads = h.heads();
  assert.deepEqual(wantHeads, [L, R].sort());

  // 破坏 heads：写入非 head 的 id 并漏掉 R
  fs.writeFileSync(path.join(dir, 'heads.json'), JSON.stringify({ heads: [root] }));
  // 破坏索引：打乱拓扑序、删除深度
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ order: [R, L, root], depth: {}, counters: {} }));

  const { h: h2, stderr } = openCapturing(dir);
  assert.deepEqual(h2.heads(), wantHeads, 'heads 已按事件图重建');
  const report = JSON.parse(stderr.trim());
  assert.equal(report.code, 'REBUILT');
  assert.deepEqual(report.rebuilt.sort(), ['heads', 'index']);
  // 磁盘上的文件也被修复
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'heads.json'), 'utf8')).heads, wantHeads);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(idx.order.length, 3);
  assert.ok(idx.order.indexOf(root) < idx.order.indexOf(L));

  // 一致时不报告
  const { stderr: quiet } = openCapturing(dir);
  assert.equal(quiet, '');
});

// 相同内容不同 id 不自动合并
test('相同内容不同 id 不自动合并', () => {
  const dir = tmpdir();
  const h = History.init(dir);
  const root = h.append({ author: 'a', payload: 'root' });
  const e1 = h.append({ author: 'x', payload: 'same', parents: [root] });
  const e2 = h.append({ author: 'y', payload: 'same', parents: [root] });
  assert.notEqual(e1, e2);
  assert.deepEqual(h.heads(), [e1, e2].sort(), '两个同内容事件并存为并发 heads');
  assert.equal(h.listEvents().length, 3, '未发生自动合并');
});

// checkout 重建序列
test('checkout 重建该 head 视角的更正序列', () => {
  const dir = tmpdir();
  const h = History.init(dir);
  const root = h.append({ author: 'a', payload: 'v1' });
  const L = h.append({ author: 'x', payload: 'v2-left', parents: [root] });
  const R = h.append({ author: 'y', payload: 'v2-right', parents: [root] });
  const m = h.merge(L, R);
  const out = h.checkout(m);
  assert.equal(out.head, m);
  assert.deepEqual(out.sequence.map((e) => e.payload), ['v1', 'v2-left', 'v2-right', '']);
  assert.equal(fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim(), m);
  // 只检出左臂：不含右臂
  const left = h.checkout(L);
  assert.deepEqual(left.sequence.map((e) => e.payload), ['v1', 'v2-left']);
});

// CLI 端到端：node cli.js merge h1 h2（沙箱限制子进程，进程内调用同一入口）
test('CLI：merge / heads / 错误 JSON', () => {
  const dir = tmpdir();
  const run = (...args) => {
    let stdout = '';
    let stderr = '';
    const status = cliRun(['--dir', dir, ...args], {
      stdout: (s) => { stdout += s + '\n'; },
      stderr: (s) => { stderr += s + '\n'; },
    });
    return { status, stdout, stderr };
  };

  assert.equal(run('init').status, 0);
  const root = JSON.parse(run('append', '--author', 'a', '--payload', 'root').stdout).id;
  const L = JSON.parse(run('append', '--author', 'x', '--payload', 'L', '--parents', root).stdout).id;
  const R = JSON.parse(run('append', '--author', 'y', '--payload', 'R', '--parents', root).stdout).id;

  const m1 = run('merge', L, R);
  assert.equal(m1.status, 0, m1.stderr);
  const head1 = JSON.parse(m1.stdout).head;
  const m2 = run('merge', R, L);
  assert.equal(JSON.parse(m2.stdout).head, head1, 'CLI 合并与顺序无关');

  const heads = JSON.parse(run('heads').stdout).heads;
  assert.deepEqual(heads, [head1]);

  const bad = run('merge', L, '0'.repeat(64));
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error, 'ERR_HEAD');

  const anc = JSON.parse(run('is-ancestor', root, head1).stdout);
  assert.equal(anc.isAncestor, true);
});
