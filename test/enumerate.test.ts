/**
 * 枚举核对：穷举小树（n=3、n=4 的全部有根标号树）与两侧合法操作序列，
 * 验证任意组合合并后无环、证据结构合法、节点不丢失、墓碑保留、结果确定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeState, NodeId, Parent, cloneTree, findCycle, wouldCycle } from '../src/tree.js';
import { mergeTrees, Op, MergeResult } from '../src/merge.js';

const ROOT = 'a';

/** 枚举 n 个节点（a 为根）的全部有根树。 */
function allTrees(ids: NodeId[]): TreeState[] {
  const rest = ids.filter((id) => id !== ROOT);
  const trees: TreeState[] = [];
  const assign = new Map<NodeId, Parent>([[ROOT, null]]);
  const walk = (i: number): void => {
    if (i === rest.length) {
      if (!findCycle(assign)) {
        trees.push({ parent: new Map(assign), tombstone: new Set() });
      }
      return;
    }
    for (const p of ids) {
      assign.set(rest[i]!, p);
      walk(i + 1);
    }
  };
  walk(0);
  assign.clear();
  return trees;
}

/** 单侧合法操作序列（长度 1..maxLen，逐操作校验不成环、目标存在）。 */
function legalOpSeqs(base: TreeState, ids: NodeId[], maxLen: number, withDelete: boolean): Op[][] {
  const rest = ids.filter((id) => id !== ROOT);
  const targets: Parent[] = [...ids, null];
  const seqs: Op[][] = [];

  const extend = (tree: TreeState, chosen: Op[], used: Set<NodeId>): void => {
    if (chosen.length > 0) seqs.push(chosen.map((op) => ({ ...op })));
    if (chosen.length === maxLen) return;
    for (const id of rest) {
      if (used.has(id)) continue;
      for (const t of targets) {
        if (t === id) continue;
        if (t !== null && !tree.parent.has(t)) continue;
        if (wouldCycle(tree.parent, id, t)) continue;
        const next = cloneTree(tree);
        next.parent.set(id, t);
        used.add(id);
        extend(next, [...chosen, { kind: 'move', id, newParent: t }], used);
        used.delete(id);
      }
      if (withDelete && chosen.length < maxLen) {
        used.add(id);
        extend(tree, [...chosen, { kind: 'delete', id }], used);
        used.delete(id);
      }
    }
  };
  extend(cloneTree(base), [], new Set());
  return seqs;
}

function checkResult(base: TreeState, res: MergeResult, ids: NodeId[], expectTombstones: Set<NodeId>): void {
  // 1. 合并结果无环
  assert.equal(findCycle(res.tree.parent), null, `cycle remains: ${res.evidence.map((e) => e.reason).join('; ')}`);
  // 2. 节点不丢失
  assert.equal(res.tree.parent.size, ids.length);
  for (const id of ids) assert.ok(res.tree.parent.has(id), `node ${id} lost`);
  // 3. 墓碑保留
  for (const t of expectTombstones) {
    assert.ok(res.tree.tombstone.has(t), `tombstone ${t} lost`);
    assert.ok(res.tree.parent.has(t), `tombstone subtree root ${t} lost`);
  }
  // 4. 证据结构合法
  const seenRounds = new Set<number>();
  for (const ev of res.evidence) {
    assert.ok(ev.cycle.length >= 2, 'cycle too short');
    assert.ok(!seenRounds.has(ev.round), 'duplicate round');
    seenRounds.add(ev.round);
    assert.ok(ev.cycle.includes(ev.cancelledEdge.child), 'cancelled edge not on cycle');
    const baseParent = base.parent.get(ev.cancelledEdge.child) ?? null;
    if (ev.edgeSource !== 'base' && baseParent !== ev.cancelledEdge.parent) {
      assert.equal(ev.revertedTo, baseParent, 'op edge must revert to base parent');
    } else {
      assert.equal(ev.revertedTo, null, 'base edge must be detached');
    }
  }
}

test('枚举 n=4 全部基底树 × 双侧合法移动序列（长度≤2）：合并无环', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const trees = allTrees(ids);
  assert.equal(trees.length, 16); // Cayley: 4^(4-2) 棵有根标号树

  let merges = 0;
  let cyclesBroken = 0;
  for (const base of trees) {
    const seqs = legalOpSeqs(base, ids, 2, false);
    for (const left of seqs) {
      for (const right of seqs) {
        const res = mergeTrees(base, left, right);
        checkResult(base, res, ids, new Set());
        // 确定性：同样输入再算一遍，结果完全一致
        const res2 = mergeTrees(base, left, right);
        assert.deepStrictEqual(res2, res);
        cyclesBroken += res.evidence.length;
        merges += 1;
      }
    }
  }
  assert.ok(merges > 100_000, `expected exhaustive coverage, got ${merges}`);
  assert.ok(cyclesBroken > 0, 'expected some combined cycles to be broken');
  console.log(`n=4: ${merges} merges, ${cyclesBroken} cycle(s) broken, all acyclic`);
});

test('枚举 n=3 含删除操作：合并无环且墓碑子树保留', () => {
  const ids = ['a', 'b', 'c'];
  const trees = allTrees(ids);
  assert.equal(trees.length, 3);

  let merges = 0;
  let tombstoneCases = 0;
  for (const base of trees) {
    const seqs = legalOpSeqs(base, ids, 2, true);
    for (const left of seqs) {
      for (const right of seqs) {
        const res = mergeTrees(base, left, right);
        const expected = new Set<NodeId>();
        for (const op of [...left, ...right]) {
          if (op.kind === 'delete') expected.add(op.id);
        }
        checkResult(base, res, ids, expected);
        if (expected.size > 0) tombstoneCases += 1;
        merges += 1;
      }
    }
  }
  assert.ok(tombstoneCases > 0, 'expected tombstone cases');
  console.log(`n=3 (with deletes): ${merges} merges, ${tombstoneCases} tombstone case(s), all acyclic`);
});
