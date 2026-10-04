# three-way-merge

字段级三方合并库：每个解决选择绑定冲突双方的源摘要（SHA-256），
源变更后仅保留仍匹配的选择，过期项自动重开冲突；不同字段的解决
彼此独立沿用。输出冲突来源（base/left/right 三方值与摘要）和
base → merged 的最终差分。仅使用 Node.js 内置模块，零运行时依赖。

## 核心概念

- `merge(base, left, right, store?)` — 字段级三方合并，返回
  `{ merged, conflicts, applied, carriedStore, diff }`。
- `resolve(conflict, value)` — 生成绑定当前双方源摘要的 `ResolutionEntry`。
- `ResolutionStore` — 按字段存放解决选择；`carriedStore` 为仍匹配
  当前源的条目（过期条目被丢弃），可直接传入下一轮合并。
- 冲突的 `cause` 为 `both-modified`（双方改同一字段）或
  `stale-resolution`（源已变、旧选择过期，附 `stale` 原条目）。
- `diff` 给出 base 到 merged 的 `added` / `removed` / `changed` 条目。

## 用法

```ts
import { merge, resolve, type ResolutionStore } from "three-way-merge";

const first = merge({ a: 1 }, { a: 2 }, { a: 3 });
// first.conflicts[0] -> { field: "a", base: 1, left: 2, right: 3, cause: "both-modified", ... }

const store: ResolutionStore = { a: resolve(first.conflicts[0]!, 99) };
merge({ a: 1 }, { a: 2 }, { a: 3 }, store).merged; // { a: 99 }
merge({ a: 1 }, { a: 2 }, { a: 4 }, store).conflicts[0]!.cause; // "stale-resolution"
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

需要环境中有 `tsc`（TypeScript 编译器）。`types/node-shims.d.ts`
是离线环境下 `node:crypto` / `node:test` / `node:assert/strict`
的最小类型声明；可联网时用 `@types/node` 替换即可。

随机化测试以固定种子（mulberry32, seed=20261005）模拟 300 轮
随机分支更新，每轮做：确定性重算、独立参考实现交叉核对、
diff 重放（base + diff == merged）、沿用条目摘要校验、冲突来源
校验，并在解决全部冲突后重算确认冲突清零。

## 实际测试结果（2026-10-05, Node v22.22.1）

```
ok 1 - clean merge: one-sided changes and convergent edits
ok 2 - conflict provenance: base/left/right values and digests reported
ok 3 - resolution binds both source digests and applies on re-merge
ok 4 - unrelated source changes keep the choice; resolutions are per-field independent
ok 5 - stale choice reopens when either side changes; converged sides drop the entry
ok 6 - deletions: remove vs edit conflicts, remove vs remove merges
ok 7 - diff output: added / removed / changed against base
ok 8 - randomized branch updates: recompute cross-check and diff replay
# tests 8
# pass 8
# fail 0
# duration_ms ~360
```
