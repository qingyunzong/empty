# lis-sequence-library

支持**末尾追加**（`append`）与**撤销**（`undo`）的序列库，可计算当前序列的
**严格递增最长子序列（LIS）**并输出**索引证书**。仅使用 TypeScript 与 Node.js
内置库（`node:test` / `node:assert`），零 npm 依赖。

## 并列打破规则

在所有最长严格递增子序列中，返回**索引序列字典序最小**的那一个（等长按索引序
最小），**不以值序代替索引序**。例如：

- 序列 `[2, 1, 3]`：最优长度 2，候选下标 `[0,2]`（值 2,3）与 `[1,2]`（值 1,3）。
  按值序最小会选 `[1,2]`，本库按索引序最小返回 `[0,2]`。
- 序列 `[1, 3, 2]`：候选 `[0,1]`（值 1,3）与 `[0,2]`（值 1,2），返回 `[0,1]`。

## API

```ts
import { SequenceLibrary } from "./src/sequence-lib.js";

const lib = new SequenceLibrary();
lib.append(2); lib.append(1); lib.append(3);
lib.undo();                       // 撤销最近一次 append -> 序列回到 [2, 1]
lib.append(3);
lib.lisCertificate();
// => { length: 2, indices: [0, 2], values: [2, 3] }  （索引证书）
lib.verifyCertificate(cert);      // 校验证书：下标/值严格递增、与序列一致、长度最优
```

- `append(value)`：末尾追加；`NaN`/非数值抛 `TypeError`。
- `undo()`：撤销最近一次 `append`；空序列抛 `RangeError`。
- `lisCertificate()`：返回 `{ length, indices, values }` 索引证书，
  算法为 O(n²) DP（`startLen[i]` = 从下标 i 起的最长严格递增子序列长度）+
  逐位取最小可行下标的贪心构造。
- `verifyCertificate(cert)`：独立校验一份证书是否合法且长度最优。

## 测试

```sh
npm test        # tsc 编译到 dist/ 后运行 node --test
npm run typecheck
```

测试对小序列**枚举全部下标子集**求出所有最优解，对照库返回的**长度**与
**唯一选择**（全部最优解中索引字典序最小者必然唯一）。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - append/undo 基本行为
ok 2 - undo 后证书与重新构建一致
ok 3 - 等长时按索引序最小，而非值序最小
ok 4 - 边界：空序列、单元素、全相等、严格递减
ok 5 - 小序列穷举：值域 {0,1,2}、长度 0..7 全部序列对照
ok 6 - 小序列穷举：值域 {1..4}、长度 0..6 全部序列对照
ok 7 - 随机序列对照（固定种子，长度至 12）
ok 8 - 证书校验：拒绝被篡改的证书
# tests 8
# pass 8
# fail 0
# duration_ms ~380-500
```

穷举覆盖统计（测试内 `console.log` 实测输出）：

- 值域 `{0,1,2}`、长度 0..7：穷举对照 **3280** 个序列，其中 **2840** 个存在多个
  最优解（并列打破规则被充分触发），全部与枚举结果一致。
- 值域 `{1..4}`、长度 0..6：穷举对照 **5461** 个序列，全部一致。
- 另有 300 组固定种子随机序列（长度 ≤ 12）对照通过。
