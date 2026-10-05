# versioned-array

支持历史快照的整数数组库（TypeScript，仅依赖 Node.js 内置模块）。

## 功能

- **半开区间赋值**：`setRange(start, end, value)` 将 `[start, end)` 赋为 `value`。
- **历史快照**：每次有效修改生成不可变快照并递增版本号；
  `snapshot(v)` / `at(i, v)` 读取任意历史版本。
- **空更新不增版本**：空区间（`start >= end`）或区间内值未发生变化的更新不产生新版本。
- **版本比较**：`diff(from, to)` 返回最大连续不同区间（含前后值）；
  相邻且差值（after - before）相同的位置合并为同一区间。

## API

```ts
import { VersionedArray } from "./src/versioned-array.js";

const arr = new VersionedArray(8, 0);   // 长度 8，初始值 0，版本 0
arr.setRange(1, 3, 4);                  // 版本 1
arr.setRange(5, 6, 2);                  // 版本 2
arr.setRange(0, 0, 9);                  // 空更新：版本仍为 2

arr.snapshot(1);                        // [0, 4, 4, 0, 0, 0, 0, 0]
arr.diff(0, 2);
// [
//   { start: 1, end: 3, before: [0, 0], after: [4, 4] },
//   { start: 5, end: 6, before: [0],    after: [2] },
// ]
```

`DiffInterval`：`{ start, end, before, after }`，`end` 为开区间端点。

## 测试

```sh
npm test   # tsc 编译后运行 node:test 测试
```

测试包含：半开区间与快照、空更新不增版本、diff 区间与同差合并、
参数校验，以及**随机更新对照测试**——以固定种子（mulberry32, seed=20261005）
生成 500 次随机区间更新，与复制的普通数组模型逐步核对版本号、
每步状态、全部历史快照，并对 200 对随机版本比较 diff 结果。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 执行 `npm test`：

```
TAP version 13
ok 1 - half-open range assignment and snapshots
ok 2 - empty updates do not bump the version
ok 3 - diff returns maximal contiguous intervals with before/after values
ok 4 - diff merges adjacent positions with the same delta only
ok 5 - invalid arguments throw
ok 6 - randomized updates match a copied plain-array model
1..6
# tests 6
# pass 6
# fail 0
# duration_ms 56.255793
```
