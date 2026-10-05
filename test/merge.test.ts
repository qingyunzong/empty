import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeState, findCycle } from '../src/tree.js';
import { mergeTrees, Op, comparePriority } from '../src/merge.js';

function baseTree(edges: Record<string, string | null>): TreeState {
  return { parent: new Map(Object.entries(edges)), tombstone: new Set() };
}

test('三方合并：两侧移动不同节点，互不干扰', () => {
  const base = baseTree({ r: null, a: 'r', b: 'r', c: 'r' });
  const left: Op[] = [{ kind: 'move', id: 'a', newParent: 'b' }];
  const right: Op[] = [{ kind: 'move', id: 'c', newParent: 'b' }];
  const { tree, evidence, conflicts } = mergeTrees(base, left, right);
  assert.equal(tree.parent.get('a'), 'b');
  assert.equal(tree.parent.get('c'), 'b');
  assert.equal(evidence.length, 0);
  assert.equal(conflicts.length, 0);
  assert.equal(findCycle(tree.parent), null);
});

test('冲突裁决：同一节点两侧都移动，操作优先级高者胜', () => {
  const base = baseTree({ r: null, a: 'r', x: 'r', y: 'r' });
  const left: Op[] = [{ kind: 'move', id: 'a', newParent: 'x' }];   // seq 0
  const right: Op[] = [
    { kind: 'move', id: 'a', newParent: 'x' },                       // seq 0
    { kind: 'move', id: 'a', newParent: 'y' },                       // seq 1，更高
  ];
  const { tree, conflicts } = mergeTrees(base, left, right);
  assert.equal(tree.parent.get('a'), 'y');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.winner.side, 'right');
  assert.equal(conflicts[0]!.winner.seq, 1);
  assert.equal(conflicts[0]!.loser.side, 'left');
});

test('跨侧同序号冲突：side 决胜（right 优先于 left）', () => {
  assert.ok(comparePriority({ seq: 0, side: 'right' }, { seq: 0, side: 'left' }) > 0);
  const base = baseTree({ r: null, a: 'r', x: 'r', y: 'r' });
  const left: Op[] = [{ kind: 'move', id: 'a', newParent: 'x' }];
  const right: Op[] = [{ kind: 'move', id: 'a', newParent: 'y' }];
  const { tree } = mergeTrees(base, left, right);
  assert.equal(tree.parent.get('a'), 'y');
});

test('组合环：双侧各自合法的移动成环，取消最低优先边并附证据', () => {
  // 基底：a、b 都挂在 r 下。left 把 a 挂到 b 下，right 把 b 挂到 a 下 —— 各自合法，组合成环。
  const base = baseTree({ r: null, a: 'r', b: 'r' });
  const left: Op[] = [{ kind: 'move', id: 'a', newParent: 'b' }];
  const right: Op[] = [{ kind: 'move', id: 'b', newParent: 'a' }];
  const { tree, evidence } = mergeTrees(base, left, right);

  assert.equal(findCycle(tree.parent), null);
  assert.equal(evidence.length, 1);

  const ev = evidence[0]!;
  assert.deepEqual([...ev.cycle].sort(), ['a', 'b']);
  // 两条边优先级 (seq0,left) 与 (seq0,right)，最低为 left 的 a->b，回退到基底父指针 r。
  assert.deepEqual(ev.cancelledEdge, { child: 'a', parent: 'b' });
  assert.equal(ev.revertedTo, 'r');
  assert.equal(tree.parent.get('a'), 'r');
  assert.equal(tree.parent.get('b'), 'a');
  assert.match(ev.reason, /lowest-priority/);
  assert.match(ev.reason, /left#0/);
});

test('环中最低优先边是基底边：按节点 ID 决胜并断开，证据记录来源 base', () => {
  // 基底：b->a, c->b。操作：a->c（唯一操作边）。环 a->c->b->a 中基底边 b->a、c->b，
  // 同为基底优先级，按节点 ID 决胜取消 b->a（b < c），回退无效故断开为 null。
  const base = baseTree({ r: null, a: 'r', b: 'a', c: 'b' });
  const left: Op[] = [{ kind: 'move', id: 'a', newParent: 'c' }];
  const { tree, evidence } = mergeTrees(base, left, []);

  assert.equal(findCycle(tree.parent), null);
  assert.equal(evidence.length, 1);
  const ev = evidence[0]!;
  assert.deepEqual(ev.cycle, ['a', 'c', 'b']);
  assert.deepEqual(ev.cancelledEdge, { child: 'b', parent: 'a' });
  assert.equal(ev.edgeSource, 'base');
  assert.equal(ev.revertedTo, null);
  assert.equal(tree.parent.get('b'), null);
  assert.equal(tree.parent.get('a'), 'c');
  assert.equal(tree.parent.get('c'), 'b');
});

test('多环逐轮解除，每轮都有证据', () => {
  // 两个独立的互换环：a<->b 与 c<->d。
  const base = baseTree({ r: null, a: 'r', b: 'r', c: 'r', d: 'r' });
  const left: Op[] = [
    { kind: 'move', id: 'a', newParent: 'b' },
    { kind: 'move', id: 'c', newParent: 'd' },
  ];
  const right: Op[] = [
    { kind: 'move', id: 'b', newParent: 'a' },
    { kind: 'move', id: 'd', newParent: 'c' },
  ];
  const { tree, evidence } = mergeTrees(base, left, right);
  assert.equal(findCycle(tree.parent), null);
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((e) => e.round), [1, 2]);
});

test('墓碑子树保留：删除的节点保留其子树，子树内合并照常进行', () => {
  const base = baseTree({ r: null, a: 'r', b: 'a', c: 'b' });
  const left: Op[] = [{ kind: 'delete', id: 'a' }];
  const right: Op[] = [{ kind: 'move', id: 'c', newParent: 'a' }];
  const { tree } = mergeTrees(base, left, right);

  assert.ok(tree.tombstone.has('a'));
  // 墓碑节点及其子树仍在树中
  assert.ok(tree.parent.has('a'));
  assert.equal(tree.parent.get('b'), 'a');   // b 仍挂在墓碑 a 下
  assert.equal(tree.parent.get('c'), 'a');   // 右侧对子树的移动照常合并
  assert.equal(findCycle(tree.parent), null);
});

test('墓碑节点自身被移动也参与合并与解环', () => {
  const base = baseTree({ r: null, a: 'r', b: 'r' });
  const left: Op[] = [
    { kind: 'delete', id: 'a' },
    { kind: 'move', id: 'a', newParent: 'b' },
  ];
  const right: Op[] = [{ kind: 'move', id: 'b', newParent: 'a' }];
  const { tree, evidence } = mergeTrees(base, left, right);
  assert.ok(tree.tombstone.has('a'));
  assert.equal(findCycle(tree.parent), null);
  assert.equal(evidence.length, 1);
});

test('合并确定性：相同输入产生相同结果', () => {
  const base = baseTree({ r: null, a: 'r', b: 'r', c: 'a' });
  const left: Op[] = [{ kind: 'move', id: 'a', newParent: 'b' }];
  const right: Op[] = [
    { kind: 'move', id: 'b', newParent: 'c' },
    { kind: 'move', id: 'c', newParent: 'r' },
  ];
  const r1 = mergeTrees(base, left, right);
  const r2 = mergeTrees(base, left, right);
  assert.deepEqual(r1, r2);
});
