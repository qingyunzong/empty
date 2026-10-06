# permission-merge

复制环境下权限授予/撤销的因果合并库（TypeScript，仅依赖 Node.js 内置模块，零 npm 依赖）。

## 语义

每个操作（`grant` / `revoke`）携带**向量时钟**作为因果版本，合并**从不读取墙钟**
（`wallClockMs` 仅作为调试元数据，算法禁止使用）。对同一权限：

- **并发授予与撤销 → 撤销获胜**（remove-wins）：授予与撤销并发时，授予不生效。
- **因果后续授予可恢复**：若授予在因果上严格晚于所有撤销（授予者已观察到撤销），
  则该授予恢复权限。
- **因果后续撤销 → 移除**：撤销者已观察到授予时，撤销生效。

形式化规则：授予 `g` 有效 ⟺ 对同一权限的每个撤销 `r`，都有 `g` 严格 happens-after `r`
（`g.clock > r.clock`，向量时钟逐分量偏序）。

## 有效权限与来源

`store.effective()` 输出每个被触及权限的：

- `granted`：当前是否有效；
- `sources`：有效状态的**来源**——偏序极大的存活授予操作（opId / 副本 / 计数）；
- `revokedBy`：无效时，偏序极大的撤销操作（解释当前撤销状态）。

## 一致性保证

`receive` / `merge` 幂等、可交换、可结合（CRDT join）：消息可任意乱序、重复、
延迟投递，观察到相同操作集合的副本必收敛到相同的有效权限集合。

## 用法

```ts
import { PermissionStore } from './src/index.js';

const alice = new PermissionStore('alice');
const bob = new PermissionStore('bob');

const grant = alice.grant('repo:push');
const revoke = bob.revoke('repo:push'); // 与 grant 并发

alice.receive(revoke);
bob.receive(grant);

alice.effectiveFor('repo:push');
// => { perm: 'repo:push', granted: false, sources: [], revokedBy: [{ opId: 'bob#1', ... }] }
```

## 测试

```
npm test        # tsc 编译 + node --test（Node 内置测试运行器）
```

测试包含一个**独立实现的"偏序极大操作"参考模型**（`test/model.ts`，自行重新实现
happens-before，不复用库代码），随机生成多副本并发场景，将所有操作按随机乱序
（含重复投递）送入新副本，逐一与模型核对。

## 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

```
$ npm test
ok 1 - dist/test/modelCheck.test.js
ok 2 - dist/test/permissionStore.test.js
# tests 2
# pass 2
# fail 0
```

逐条用例（13 个，全部通过）：

```
ok 1 - concurrent grant and revoke of the same permission -> revoke wins
ok 2 - causal grant after a revoke restores the permission
ok 3 - revoke causally after a grant removes the permission
ok 4 - grant -> revoke -> grant chain: the newest causal grant wins
ok 5 - provenance: concurrent surviving grants are all reported as sources
ok 6 - merging is order-independent: shuffled delivery converges to the same state
ok 7 - duplicate delivery is idempotent
ok 8 - wall-clock metadata is never consulted: misleading timestamps cannot reorder causality
ok 9 - merge of snapshots is commutative and idempotent (CRDT join)
ok 10 - independent permissions do not interfere
ok 1 - randomized scenarios: store matches the partial-order maximal-op model under shuffled, out-of-order delivery
ok 2 - convergence: replicas that gossip pairwise all reach the model state
ok 3 - causal versions are preserved: every op carries a vector clock and the store version is the join
```

其中随机化核对：40 个随机场景 × 每场景 15 次乱序/重复投递，均与偏序极大操作
模型逐权限一致（种子固定为 20261006，可复现）。
