# state-sequence（状态序列库）

TypeScript 实现的状态序列库，仅使用 Node.js 内置模块（`node:test` / `node:assert`），零运行时依赖。

## 语义

- **样本持有**：每个样本自其时间戳 `t` 起生效，直到下一个样本出现或自身 `ttl` 到期（两者取先）；未指定 `ttl` 时一直持有到下一个样本。
- **过期空洞不延长**：`ttl` 到期后进入空洞（无值），后续样本不会向前填补空洞；删除样本后，前一样本也仅延展到自身 `ttl` 为止。
- **同时间更正**：同一时间戳的样本以版本号高者为准；仅严格更高的版本会替换，等于或更低版本的插入被拒绝（`insert` 返回 `false`）。
- **范围查询**：`query(start, end)` 输出 `[start, end)` 内裁剪后的**最大等值半开段**序列；空洞不出现在输出中，相邻同值段被合并，空洞两侧的同值段不合并。

## API

```ts
import { StateSequence } from "./dist/src/state-sequence.js";

const seq = new StateSequence<string>();           // 可传入自定义等值函数
seq.insert({ t: 10, version: 0, value: "a", ttl: 5 }); // -> boolean
seq.insert({ t: 10, version: 1, value: "a2" });    // 同时间更正，高版本生效
seq.delete(10);                                     // -> boolean
seq.at(12);                                         // 单 tick 求值
seq.query(0, 30);  // -> [{ start, end, value }, ...] 最大等值半开段
```

## 验证方法

`test/tick-interpreter.ts` 是逐 tick 参考解释器（朴素实现：每个整数 tick 独立求值再扫描合并）。
`test/property.test.ts` 用确定性伪随机序列（40 个种子 × 400 步插入/删除，外加 3000 次密集同时间更正）
逐步比对两个实现的插入/删除返回值、单点值与范围查询段输出；`test/state-sequence.test.ts` 覆盖上述语义的定向用例。

## 构建与测试

```sh
npm test   # = tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

依赖：Node.js（开发环境为 v22.22.1）与 `tsc`（开发环境为 TypeScript 7.0.2）。
`types/node-shim.d.ts` 是离线环境下 `node:test` / `node:assert/strict` 的最小类型声明；
有网络时可 `npm i -D @types/node` 替换。

## 实际测试结果（2026-10-05，Node v22.22.1）

`npm test` 输出摘要：

```
# Subtest: dist/test/property.test.js
ok 1 - dist/test/property.test.js   (duration_ms: 912.06)
# Subtest: dist/test/state-sequence.test.js
ok 2 - dist/test/state-sequence.test.js   (duration_ms: 499.84)
# tests 2
# pass 2
# fail 0
```

逐用例明细（`node --test-reporter=spec`）：共 17 个用例全部通过 ——

- `state-sequence.test.js`：15 个定向用例全部 ✔（含“TTL 到期产生空洞，空洞不被后续样本延长”“同时间更正：版本高者生效”“删除后前一样本仍受自身 TTL 限制”“相邻同值段合并为最大等值段”等）
- `property.test.js`：2 个随机化核对用例全部 ✔（`随机插入/删除与逐 tick 解释器逐步核对` 529.8ms；`密集同时间更正（版本竞争）与解释器一致` 9.1ms）
