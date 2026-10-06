# diff-constraints

别名差值约束库：以字符串别名记录变量差值约束 `x - y = d`（`bigint` 精度），
支持差值查询、快照/回滚，以及带证据路径的矛盾拒绝。

## 使用

```ts
import { DifferenceConstraints } from './src/diff-constraints.js';

const dc = new DifferenceConstraints();

dc.add('a', 'b', 3n);          // a - b = 3
dc.add('b', 'c', 4n);          // b - c = 4
dc.query('a', 'c');            // { kind: 'known', diff: 7n }
dc.query('a', 'stranger');     // { kind: 'unknown' } —— 断开（不连通）变量

const snap = dc.snapshot();    // 快照
dc.add('c', 'd', 5n);
dc.rollback(snap);             // 回滚：c、d 重新断开

const res = dc.add('a', 'c', 100n);  // 与已有 a - c = 7 矛盾
// res = { ok: false, reason: 'contradiction', implied: 7n, evidence: [...] }
// evidence 是一个闭合环：既有路径 a ~~> c 的各条边，加上被拒绝约束的反向边
// (c -> a, -100n)；环上差值之和 = implied - d ≠ 0，即为矛盾证据。
// 被拒绝的约束不会修改库状态。
```

## 语义

- `add(x, y, d)`：记录 `x - y = d`。与既有约束矛盾时拒绝并返回证据路径，状态不变。
- `query(x, y)`：连通时返回 `{ kind: 'known', diff }`；断开或未知变量返回
  `{ kind: 'unknown' }`。自反查询 `query(x, x)` 恒为 `0n`。
- `snapshot()` / `rollback(handle)`：回滚到快照时刻的精确状态；
  回滚会使比目标更新的快照句柄失效。
- 所有差值均为 `bigint`，无精度上限。

## 实现

无路径压缩的加权并查集（按大小合并），父链保持完整，因此合并操作可逆：
`snapshot()` 记录撤销日志长度，`rollback()` 逐个撤销。查询与合并均为近 O(α)～O(log n)。

## 测试

```sh
npm test    # tsc 编译 + node --test
```

测试包含单元用例（链式传递、断开返回 unknown、大整数、矛盾证据环校验、
嵌套快照回滚）和随机化微分测试：固定种子的随机小图上交替执行
add/snapshot/rollback/query，每步之后用独立的势能 BFS 模型对全部变量对
逐一核验差值（含回滚后的状态）。
