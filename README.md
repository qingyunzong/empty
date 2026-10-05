# lis-sequence-library

序列库：支持末尾追加（`append`）与撤销（`undo`），返回严格递增最长子序列（LIS）。
等长平局时按**索引序**取字典序最小——绝不以值序代替索引序。结果以**索引证书**
（index certificate）形式输出，可独立验证；小序列用子集枚举对照长度与唯一选择。

仅使用 Node.js 内置模块（`node:test`、`node:assert`），无运行时依赖；
TypeScript 仅作编译器（devDependency，环境中为全局 tsc 7.0.2）。

## 使用

```ts
import { SequenceLibrary } from "./src/sequence-library";

const lib = new SequenceLibrary();
lib.append(1);
lib.append(0);
lib.append(2);
const cert = lib.lisCertificate();
// cert = { length: 2, indices: [0, 2], values: [1, 2] }
// 注意：值序最小的是 (0,2)（索引 [1,2]），但索引序最小为 [0,2]。
lib.verify(cert); // true
lib.undo();       // 撤销末尾追加
```

## 算法

1. `lisFrom[i]`：从右向左用值域压缩 + 树状数组（Fenwick，后缀最大值）求
   以 i 开头的最长严格递增子序列长度，O(n log n)。
2. 贪心重构：第 k 个元素取满足 `a[i] > 前一值` 且 `lisFrom[i] === 剩余长度`
   的**最小下标** i。该下标必然存在，逐位取最小可行下标即得索引序字典序最小
   （交换论证）。经典“最小尾值”重构最小化的是值序列，这里刻意不用。
3. 证书验证 `verifyCertificate`：下标在界内且严格递增、取值与序列一致且严格
   递增、长度等于独立的长度预言机（耐心排序 O(n log n)）。

## 测试

```sh
npm test   # tsc 编译后用 node --test 运行 dist/test/*.test.js
```

覆盖：追加/撤销状态、索引序 vs 值序平局裁定、证书接受/篡改拒绝、
小序列全枚举对照（字母表 2/3/4，长度至 8/8/6，共 15813 个序列逐一与
子集枚举比对长度与唯一选择）、固定种子随机对照、撤销后证书逐步回放一致、
n=2000 大序列证书有效性。实际结果见 [RESULTS.md](RESULTS.md)。
