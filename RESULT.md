# RESULT

日期：2026-10-03 ｜ 环境：Node.js v22.22.1，仅标准库，`node:test`，单机离线。

## 测试（`node --test`，真实运行输出）

```
ok 1 - test/acceptance.test.js
ok 2 - test/audit.test.js
ok 3 - test/errors.test.js
ok 4 - test/helpers.js
ok 5 - test/optimize.test.js
# tests 5
# pass 5
# fail 0
# duration_ms 11838.134257
```

共 22 个子测试全部通过：

- `test/acceptance.test.js`（7）：等级继承类目；**A** 黑名单覆盖让步（同额非黑名单客户为对照）；金额阈值上/等/下三态（平级拒绝）；**B** 撤销返工后库存恢复、预算未恢复，显式 `budget_correction` 才回补；**C** 同额并列在预算约束与单 sku 库存约束下均按 id 字典序确定性选择；双重约束同时生效。
- `test/audit.test.js`（6）：生成台账守恒通过；篡改余额被 `step_conservation` 拦截；伪造撤销时隐式回补预算被 `budget_increase_only_via_correction` 拦截；**反例**：内部守恒但超预算的台账在仅守恒检查下通过，`minimalMissingConstraints` 指出最少缺失约束为 `["budget_non_negative"]`；无对应返工的撤销被拦截；全检查集下无缺失。
- `test/errors.test.js`（5）：库存为负 exit 19；预算币种未知 exit 20；成本币种与预算币种不一致 exit 20；缺陷号重复 exit 21；正常路径写出 `decision.jsonl` / `ledger.jsonl`。
- `test/optimize.test.js`（4）：**D** 分支限界精确解与朴素枚举在 150 个 n≤16 随机实例及 3 个 n=20 边界实例上逐一一致；字典序比较器语义；空候选集。

## CLI 端到端（真实运行）

`run`：5 缺陷（含黑名单客户、临界品、超能力候选）+ 撤销 + 预算更正 → 退出码 0，输出 5 条决策、8 条台账；撤销行 `stockDelta:+1, budgetDelta:0`（库存回补、预算未回补），随后 `budget_correction` 显式回补 10。

`audit`：
- 正常台账全检查 → `ok: true`，exit 0。
- 超预算台账（budgetAfter −15）全检查 → 检出 `budget_non_negative`，exit 1。
- 同一台账仅 `--checks init_conservation,step_conservation --counterexample` → 通过，反例输出 `"minimalMissing": ["budget_non_negative"]`。

注：沙箱禁止在测试进程内再 spawn 子进程，故 CLI 测试通过 `src/cli.js` 导出的 `main(argv, io)` 进程内调用验证退出码与输出文件；真实子进程端到端运行结果如上（手动执行验证）。
