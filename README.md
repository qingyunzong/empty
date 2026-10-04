# versioned-array

TypeScript 整数数组库，支持：

- **半开区间赋值**：`set(start, end, value)` 将 `[start, end)` 赋为同一整数
- **历史快照**：每次实际变更产生一个新版本，任意版本可读取（`toArray(v)` / `get(i, v)`）
- **版本比较**：`diff(from, to)` 返回最大连续不同区间，附前后值；
  相邻且 `(before, after)` 相同的段自动合并
- **空更新不增版本**：空区间或值未变化的更新不会创建新版本

仅使用 Node.js 内置模块（`node:test` / `node:assert`），无运行时依赖。

## 示例

```ts
import { VersionedArray } from './src/versioned-array.js';

const arr = new VersionedArray(10, 0);
arr.set(2, 4, 5);        // v1: [2,4) = 5
arr.set(4, 6, 5);        // v2: [4,6) = 5
arr.set(2, 4, 5);        // 空更新，版本仍为 2

arr.diff(0, 2);
// => [{ start: 2, end: 6, before: 0, after: 5 }]   // 相邻同差已合并

arr.toArray(1);          // 历史快照: [0,0,5,5,0,0,0,0,0,0]
```

## 实现说明

每个版本存储为不可变的有序游程段（run-length segments）列表，段间结构独立；
`set` 为 O(段数)，`diff` 为双指针归并 O(段数)。版本号即快照数组下标。

## 测试

```sh
npm test    # tsc 编译后运行 node:test 测试
```

测试包含确定性种子（mulberry32, seed=20261005）的随机对拍：2000 次随机区间更新
与“复制数组模型”逐步核对版本号、全部历史版本内容，以及 500 组随机版本对的
diff 结果（与暴力模型 diff 对比）。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc），2026-10-05 运行：

```
# Subtest: half-open interval assignment and snapshots
ok 1 - half-open interval assignment and snapshots
# Subtest: empty updates do not create new versions
ok 2 - empty updates do not create new versions
# Subtest: diff returns maximal contiguous differing intervals with before/after
ok 3 - diff returns maximal contiguous differing intervals with before/after
# Subtest: diff merges adjacent positions with the same (before, after) pair
ok 4 - diff merges adjacent positions with the same (before, after) pair
# Subtest: diff across non-adjacent versions
ok 5 - diff across non-adjacent versions
# Subtest: invalid inputs are rejected
ok 6 - invalid inputs are rejected
# Subtest: randomized updates cross-checked against a copied-array model
ok 7 - randomized updates cross-checked against a copied-array model
# tests 7
# pass 7
# fail 0
# duration_ms ~52
```

7/7 通过。

## 文件结构

- `src/versioned-array.ts` — 库实现（`VersionedArray`、`diffSegments`）
- `test/versioned-array.test.ts` — 单元测试 + 随机对拍
- `types/node-shim.d.ts` — `node:test` / `node:assert` 的最小类型声明（替代 @types/node）
