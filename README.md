# fixture-store

夹具库：不可变基线 + 分叉（fork）+ 三方合并（three-way merge），支持任意对象图
（共享别名、循环引用）。仅使用 TypeScript 与 Node.js 内置模块，零 npm 依赖。

## 设计

- **稳定 ID**：每个进入仓库的对象在提交时分配稳定数值 ID，存于 `WeakMap`
  （不污染用户数据，冻结对象同样适用）。循环引用与共享节点均以 ID 标识。
- **不可变基线**：基线在提交时经过保留别名/循环的深拷贝后整体 `Object.freeze`
  深度冻结，任何写入都无法改动它。
- **分叉**：`fork()` 生成保留别名与循环的深拷贝工作副本，克隆体继承源对象的
  稳定 ID。分支写入只作用于工作副本，不污染基线。
- **三方合并**：`merge(branch)` 以「base = 分叉时的基线、ours = 当前基线、
  theirs = 分支工作副本」按稳定 ID 对齐节点逐字段合并：
  - 仅一侧修改 → 取该侧；
  - 两侧修改为相同值 → 取该值；
  - 两侧修改为不同值（含 删除 vs 修改）→ 记录冲突（含路径），合并失败，
    基线保持不变；
  - 合并按 ID 建备忘录，循环引用与共享别名在结果中原样保留，且节点 ID
    跨 fork/merge 保持稳定。

## API

```ts
import { FixtureStore } from "./src/store";

const store = new FixtureStore({ a: { x: 1 } });
const branch = store.fork();          // 分叉
(branch.working as any).a.x = 2;      // 分支写入，不影响 store.baseline
const result = store.merge(branch);   // 三方合并
// result.ok === true  → store.baseline 已更新为新的不可变基线
// result.ok === false → result.conflicts: [{ path, base, ours, theirs }]
store.idOf(obj);                      // 查询对象的稳定 ID
```

## 测试

- 参考模型（`test/model.ts`）：独立的递归深复制 + 双射结构相等性检查
  （验证共享拓扑同构，即别名与循环结构完全一致）。
- 随机对象图（mulberry32 确定性种子，含共享子对象与循环引用）+ 随机编辑
  脚本，合并结果与深复制参考模型逐一核对（200 组随机图）；另有 100 组
  随机冲突用例与 200 组循环拓扑/稳定 ID 用例。

运行：

```sh
npm test            # tsc 编译 + node --test（Node 内置测试运行器）
npm run test:verbose  # 逐条 TAP 输出
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc），Linux。

`npm test` 实际输出：

```
> fixture-store@0.1.0 test
> tsc -p tsconfig.json && node --test dist/test/store.test.js

TAP version 13
# Subtest: dist/test/store.test.js
ok 1 - dist/test/store.test.js
# tests 1
# pass 1
# fail 0
```

`npm run test:verbose` 逐条结果（全部通过）：

```
ok 1 - baseline is immutable (deep-frozen)
ok 2 - fork preserves aliases and cycles; matches reference deep copy
ok 3 - branch writes do not pollute the baseline
ok 4 - merge combines disjoint changes from two branches
ok 5 - conflicting writes to the same field are reported, baseline untouched
ok 6 - identical writes on both sides are not a conflict
ok 7 - delete vs modify conflicts; delete vs delete merges
ok 8 - arrays merge element-wise: push on one side, edit on the other
ok 9 - stable ids, aliases and cycles survive fork and merge
ok 10 - merging a cyclic edit through an alias updates every path
ok 11 - randomized: merges of random graphs match the deep-copy reference model
ok 12 - randomized: same-field different-value edits always conflict
ok 13 - randomized: cyclic random graphs keep topology through fork+merge
# tests 13
# pass 13
# fail 0
```

注：本环境的 Node 构建在 `node --test` 下将每个文件聚合为单条结果
（失败会正确传播为非零退出码），逐条明细见 `test:verbose`。

## 文件结构

- `src/store.ts` — FixtureStore / Branch 实现
- `test/model.ts` — 参考模型（深复制、结构相等、随机图/编辑生成器）
- `test/store.test.ts` — 确定性 + 随机化测试（node:test）
- `types/node-shims.d.ts` — node:test / node:assert 的最小类型声明（避免 @types 依赖）
