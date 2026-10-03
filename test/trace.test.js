'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TraceStore, TraceError } = require('../lib');

// 验收 1：多父批次只在所有支持消失后移出影响锥
test('multi-parent batch stays until all supports are gone', () => {
  const s = new TraceStore();
  s.addEdge('s', 'x', 1);
  s.addEdge('s', 'y', 1);
  s.addEdge('x', 'z', 1);
  s.addEdge('y', 'z', 1);
  s.markBad('s');
  assert.equal(s.cone.size, 4); // s,x,y,z
  s.delEdge('x', 'z');
  assert.ok(s.cone.has('z'), 'z still supported via y');
  assert.equal(s.cone.size, 4);
  s.delEdge('y', 'z');
  assert.ok(!s.cone.has('z'), 'z leaves cone only after last support disappears');
  assert.equal(s.cone.size, 3);
  // 查询同步反映
  assert.deepEqual(s.query('x').affected, ['s', 'x']);
});

// 验收 2：插入捷径扩大影响锥且 coneSize 精确
test('shortcut insertion grows cone with exact coneSize', () => {
  const s = new TraceStore();
  s.addEdge('a', 'b', 1);
  s.addEdge('c', 'd', 1);
  s.addEdge('d', 'e', 1);
  s.markBad('a');
  assert.equal(s.query('b').coneSize, 2); // {a,b}
  s.addEdge('b', 'c', 1); // 捷径：连通第二个分量
  const r = s.query('e');
  assert.equal(r.coneSize, 5); // {a,b,c,d,e} 精确
  assert.deepEqual(r.affected, ['a', 'b', 'c', 'd', 'e']);
  // 删除捷径后精确回落
  s.delEdge('b', 'c');
  assert.equal(s.query('b').coneSize, 2);
});

// 验收 3：n<=8 随机 DAG 与显式反向 BFS 对照
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random DAG ops match explicit forward/reverse BFS reference', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rnd = mulberry32(seed);
    const n = 2 + Math.floor(rnd() * 7); // 2..8
    const nodes = Array.from({ length: n }, (_, i) => 'n' + i);
    const store = new TraceStore();
    // 独立参考模型
    const refEdges = new Map(); // key -> ver
    const refBad = new Set();
    const verOf = new Map();

    const refCone = () => {
      const out = new Map(nodes.map((x) => [x, []]));
      for (const k of refEdges.keys()) {
        const [u, v] = k.split('→');
        out.get(u).push(v);
      }
      const seen = new Set(refBad);
      const q = [...refBad];
      while (q.length) {
        const u = q.shift();
        for (const v of out.get(u)) if (!seen.has(v)) { seen.add(v); q.push(v); }
      }
      return seen;
    };
    const refAncestors = (target) => {
      const inn = new Map(nodes.map((x) => [x, []]));
      for (const k of refEdges.keys()) {
        const [u, v] = k.split('→');
        inn.get(v).push(u);
      }
      const seen = new Set([target]);
      const q = [target];
      while (q.length) {
        const u = q.shift();
        for (const p of inn.get(u)) if (!seen.has(p)) { seen.add(p); q.push(p); }
      }
      return seen;
    };

    const ops = 40 + Math.floor(rnd() * 40);
    for (let step = 0; step < ops; step++) {
      const kind = rnd();
      if (kind < 0.4) {
        // 随机保序加边（i<j 保证无环）
        const i = Math.floor(rnd() * n);
        const j = Math.floor(rnd() * n);
        if (i >= j) continue;
        const key = nodes[i] + '→' + nodes[j];
        if (refEdges.has(key)) continue;
        const ver = 1 + Math.floor(rnd() * 5);
        store.addEdge(nodes[i], nodes[j], ver);
        refEdges.set(key, ver);
        verOf.set(key, ver);
      } else if (kind < 0.6) {
        // 删除一条存在的边
        const keys = [...refEdges.keys()];
        if (keys.length === 0) continue;
        const key = keys[Math.floor(rnd() * keys.length)];
        const [u, v] = key.split('→');
        store.delEdge(u, v);
        refEdges.delete(key);
      } else if (kind < 0.8) {
        const existing = [...store.nodes];
        if (existing.length === 0) continue;
        const node = existing[Math.floor(rnd() * existing.length)];
        store.markBad(node);
        refBad.add(node);
      } else {
        // 查询并对照（只选已存在节点；未知节点属错误路径，另测）
        const existing = [...store.nodes];
        if (existing.length === 0) continue;
        const target = existing[Math.floor(rnd() * existing.length)];
        const r = store.query(target);
        const cone = refCone();
        const anc = refAncestors(target);
        const expected = [...cone].filter((x) => anc.has(x)).sort();
        assert.deepEqual(r.affected, expected, `seed=${seed} step=${step} affected`);
        assert.equal(r.coneSize, cone.size, `seed=${seed} step=${step} coneSize`);
        assert.deepEqual([...store.cone].sort(), [...cone].sort(), `seed=${seed} step=${step} cone`);
      }
    }
  }
});

// 验收 4：证书重放与当前库一致；篡改版本则失败
test('certificate replays consistently against current store', () => {
  const s = new TraceStore();
  s.addEdge('m0', 'm1', 1);
  s.addEdge('m1', 'm2', 3);
  s.addEdge('m0', 'm2', 2);
  s.addEdge('m2', 'm3', 1);
  s.markBad('m0');
  const { affected, cert } = s.query('m3');
  const replay = s.verifyCert(cert);
  assert.ok(replay.ok, replay.errors.join('; '));
  assert.deepEqual(replay.affected, affected);
  assert.equal(replay.queryHash, cert.queryHash);
  // 与当前库重新查询一致
  assert.deepEqual(s.query('m3').affected, replay.affected);
  // 篡改边版本 -> 重放失败
  const tampered = JSON.parse(JSON.stringify(cert));
  tampered.items[0].edges[0].ver += 100;
  assert.equal(s.verifyCert(tampered).ok, false);
  // 篡改受影响集合 -> 查询哈希不匹配
  const tampered2 = JSON.parse(JSON.stringify(cert));
  tampered2.items.pop();
  assert.equal(s.verifyCert(tampered2).ok, false);
});

// 验收 5：delEdge 不存在报错且状态哈希不变
test('delEdge on missing edge errors and leaves state hash unchanged', () => {
  const s = new TraceStore();
  s.addEdge('a', 'b', 1);
  s.addEdge('b', 'c', 1);
  s.markBad('a');
  const before = s.stateHash();
  assert.throws(() => s.delEdge('a', 'c'), TraceError);
  assert.throws(() => s.delEdge('zzz', 'yyy'), /does not exist/);
  assert.equal(s.stateHash(), before, 'state hash must be unchanged after failed delEdge');
});

// 错误：成环 / 版本回退 / query 未知节点 -> TraceError（退出码 11）
test('cycle, version rollback and unknown query node are rejected', () => {
  const s = new TraceStore();
  s.addEdge('a', 'b', 1);
  s.addEdge('b', 'c', 1);
  assert.throws(() => s.addEdge('c', 'a', 1), /cycle/);
  assert.throws(() => s.addEdge('a', 'a', 1), /cycle/);
  assert.throws(() => s.addEdge('a', 'b', 0), /version rollback/);
  s.addEdge('a', 'b', 2); // 同边升级允许
  assert.equal(s.edges.get('a→b').ver, 2);
  assert.throws(() => s.query('ghost'), /unknown node/);
  for (const fn of [
    () => s.addEdge('c', 'a', 1),
    () => s.addEdge('a', 'b', 0),
    () => s.query('ghost'),
    () => s.delEdge('a', 'c'),
  ]) {
    try { fn(); assert.fail('should throw'); }
    catch (e) { assert.equal(e.exitCode, 11); }
  }
});

// CLI 端到端：正常输出 + 错误退出码 11（进程内调用 main，真实退出码见 README）
test('cli emits query results and exits 11 on input errors', () => {
  const { main } = require('../cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  const okFile = path.join(dir, 'ok.jsonl');
  fs.writeFileSync(okFile, [
    '{"edge":{"from":"a","to":"b","ver":1}}',
    '{"edge":{"from":"b","to":"c","ver":1}}',
    '{"markBad":{"node":"a"}}',
    '{"query":{"node":"c"}}',
  ].join('\n') + '\n');
  let stdout = '';
  let stderr = '';
  const io = { out: (s) => { stdout += s; }, err: (s) => { stderr += s + '\n'; } };
  assert.equal(main(['node', 'cli.js', okFile], io), 0);
  const line = JSON.parse(stdout.trim().split('\n')[0]);
  assert.deepEqual(line.affected, ['a', 'b', 'c']);
  assert.equal(line.coneSize, 3);
  assert.ok(line.cert.queryHash);
  assert.equal(line.cert.items.length, 3);

  const cases = [
    { name: 'cycle', lines: ['{"edge":{"from":"a","to":"b","ver":1}}', '{"edge":{"from":"b","to":"a","ver":1}}'], match: /cycle/ },
    { name: 'rollback', lines: ['{"edge":{"from":"a","to":"b","ver":2}}', '{"edge":{"from":"a","to":"b","ver":1}}'], match: /version rollback/ },
    { name: 'unknown-query', lines: ['{"edge":{"from":"a","to":"b","ver":1}}', '{"query":{"node":"ghost"}}'], match: /unknown node/ },
    { name: 'del-missing', lines: ['{"edge":{"from":"a","to":"b","ver":1}}', '{"delEdge":{"from":"a","to":"c"}}'], match: /does not exist/ },
  ];
  for (const c of cases) {
    const f = path.join(dir, c.name + '.jsonl');
    fs.writeFileSync(f, c.lines.join('\n') + '\n');
    stderr = '';
    assert.equal(main(['node', 'cli.js', f], { out: () => {}, err: (s) => { stderr += s; } }), 11, c.name);
    assert.match(stderr, c.match, c.name);
  }
});
