# explain-slice

解释库：当依赖多个输入的断言失败时，返回**最小原因切片**（minimal cause slice），
并输出**可重放证据**（replayable evidence）。仅使用 TypeScript + Node.js 内置模块
（`node:test`、`node:assert`、`node:crypto`），无第三方依赖。

## 语义

- `explain(fn, inputs)` 用代理记录 `fn` 执行期间对 `inputs` 的每一次读取（动态来源追踪）。
- `claim(condition, message)` 失败时抛出 `AssertionFailure`，其切片 = 自上一个
  `claim` 边界以来读取过的输入集合（即该次断言求值实际依赖的输入）。
- **未执行分支不计来源**：代理只记录真实发生的读取，未走到的分支里的输入不会出现
  在 `reads` 或切片中。
- **错误与断言失败分离**：普通异常返回 `{ kind: "error", errorName, errorMessage }`，
  不产生切片与证据；断言失败返回 `{ kind: "assertion-failure", minimal, evidence, ... }`；
  全部通过返回 `{ kind: "success", reads }`。
- **输入上限 20**：超过抛出 `RangeError`。

## 最小性的穷举验证

对断言失败，库对所有输入逐一执行**单输入移除**（≤20 次运行）：

- 切片成员：移除后原失败必须**不再复现**（变为成功、报错、不同的断言失败，
  或断言求值读到了缺失输入 `assertion-failure(absent-input)`）——证明每个成员必要。
- 非成员：移除后原失败必须**仍然复现**（同消息、同断言序号、未读缺失输入）——
  证明其余输入与失败无关。
- 另做一次**充分性运行**：只保留切片输入，失败必须复现。

`consistent = true` 表示上述两类检查全部符合预期；若前置断言门控了失败
（移除某非切片输入会导致更早的断言先失败），则 `consistent = false`，
各移除结果仍完整记录在证据中。

## 可重放证据

`evidence` 为可 JSON 序列化对象：原始输入、读取集、最小切片、全部移除检查、
充分性检查，以及对 `{assertion, inputs, minimal}` 规范化 JSON 的 SHA-256 摘要。
`replay(evidence, fn)` 先校验摘要（防篡改），再用证据中的输入重跑 `fn`，
确认同一断言以同一切片失败。

## 使用

```ts
import { explain, replay } from "./src/explain";

const result = explain((inputs, claim) => {
  const total = (inputs.price as number) * (inputs.qty as number);
  claim(total <= (inputs.budget as number), "total-within-budget");
}, { price: 30, qty: 2, budget: 50, note: "gift" });
// result.kind === "assertion-failure"
// result.minimal === ["budget", "price", "qty"]  （note 未被读取，不计入）

if (result.kind === "assertion-failure") {
  replay(result.evidence, fn); // { ok: true, reason: "reproduced" }
}
```

要求：`fn` 必须是确定性同步函数；输入值须可 JSON 序列化。

## 测试

```
npm test    # tsc 编译后运行 node --test
```

## 实测结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出（TAP 汇总）：

```
# tests 1
# pass 1
# fail 0
```

测试文件内 8 个用例全部通过（`node dist/test/explain.test.js`）：

```
ok 1 - assertion depending on multiple inputs yields minimal slice of exactly those inputs
ok 2 - inputs read only in unexecuted conditional branches are not counted as sources
ok 3 - plain errors are reported separately from assertion failures
ok 4 - exhaustive single-input removal verifies slice minimality over all inputs
ok 5 - at most 20 inputs are supported
ok 6 - evidence is replayable and tampering is detected
ok 7 - passing assertions report success with read provenance
ok 8 - gating earlier claims surface as inconsistent removal checks
# tests 8
# pass 8
# fail 0
```
