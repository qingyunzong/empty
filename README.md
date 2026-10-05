# fixture-graph

夹具库（TypeScript + Node.js 内置库，零运行时依赖）：不可变基线、分叉与三方合并，
保留对象共享别名，循环引用以稳定 ID 处理，分支写入不污染基线。

## 设计

- **不可变基线**：`commit(graph)` 把对象图遍历成一张节点表（`Map<NodeId, Node>`），
  快照及其节点、字段全部 `Object.freeze`，任何写入都不会改动已有快照。
- **稳定 ID**：库内以 `WeakMap<object, NodeId>` 维护对象身份。`materialize()` 产出的
  对象会被登记，修改后重新 `commit()` 仍保留原 ID；循环引用只是节点引用既有 ID，
  因此自环、互环都能安全往返，合并也不会栈溢出。
- **别名保留**：共享引用在节点表中只存一份，`materialize()` 用 id→对象 备忘表重建，
  检出的图中 `a === b` 的共享关系与环拓扑完全保留。
- **分叉**：`fork(snapshot)` 返回一个 `Branch`，因为快照不可变，分叉是零拷贝的；
  `checkout()` 得到可变的全新对象图，`commit()` 生成全新快照，基线不受污染。
- **三方合并**：`merge(base, ours, theirs)` 按节点 ID、再按字段做三方合并：
  - 一侧未改 → 取另一侧；两侧相同 → 直接接受；
  - **三方同字段不同值**（base/ours/theirs 两两不同）→ 报告 `field-value` 冲突；
  - 删除 vs 修改 → `delete-modify` 冲突；双侧新增不同节点 → `add-add` 冲突；
  - 冲突只报告、不静默解决（返回 `{ ok: false, conflicts }`）。

## 用法

```ts
import { FixtureLibrary } from "./src/fixture";

const lib = new FixtureLibrary();
const baseline = lib.commit({ user: { name: "ada" } });   // 不可变基线

const branch = lib.fork(baseline);                        // 零拷贝分叉
const draft = branch.checkout<{ user: { name: string } }>();
draft.user.name = "grace";                                // 分支写入
const ours = branch.commit(draft);                        // 新快照，基线不变

const result = lib.merge(baseline, ours, lib.commit(other));
if (result.ok) console.log(lib.materialize(result.snapshot));
else console.error(result.conflicts);
```

## 测试

```
npm test    # tsc && node --test "dist/test/*.test.js"
```

随机对象图（含别名与环，种子化 PRNG 生成）与独立的深复制参考模型
（`test/reference.ts`：记忆化深拷贝 + 捕获别名拓扑的规范签名）逐项核对；
同一变异脚本同时重放到库检出图与参考克隆图上，签名必须一致。

### 实际结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
▶ immutable baseline
  ✔ snapshot node table is frozen
  ✔ branch writes do not pollute the baseline
  ✔ mutating the source object after commit does not affect the snapshot
▶ aliases and cycles
  ✔ shared references stay shared through commit + materialize
  ✔ self and mutual cycles round-trip via stable IDs
  ✔ node IDs are stable across commits of the same objects
▶ three-way merge
  ✔ merges non-conflicting changes from both sides
  ✔ reports conflict when both sides set the same field to different values
  ✔ accepts identical changes on both sides
  ✔ reports delete-vs-modify conflict
  ✔ merges through cycles without stack overflow
  ✔ one-sided changes always merge cleanly
▶ random graphs vs deep-copy reference model
  ✔ round-trip matches reference deep clone (structure + alias topology)
  ✔ random branch mutations never pollute the baseline
  ✔ library checkout mutated by script matches reference clone mutated by same script
  ✔ one-sided random mutations merge cleanly and match the mutated side
ℹ tests 16
ℹ pass 16
ℹ fail 0
```
