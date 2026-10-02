# RESULT

- 环境：Node.js v22.22.1，仅标准库，`node:test`，单机离线
- 命令：`node --test`
- 时间：2026-10-02T23:31:32Z（UTC）
- 结果：**全部通过**（exit 0）

## 真实测试输出（摘要）

```text
ok 1 - test/acceptance.test.js
ok 2 - test/errors.test.js
ok 3 - test/helpers.js
ok 4 - test/ledger.test.js
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 40884.136154
```

## 验收点覆盖

- **A 黑名单覆盖让步**：`test/acceptance.test.js` — 黑名单客户金额远低于阈值仍判
  `scrap`（rule `blacklist`）；无黑名单时按金额阈值判定，等于阈值平级拒绝（`tie-reject`）。
- **B 撤销返工库存恢复、预算不恢复**：撤销后库存回补、预算不变；显式
  `budgetCorrection` 事件后预算才恢复，台账审计通过。
- **C 同额并列最优确定性选择**：两个同额缺陷竞争一份预算，输入顺序打乱后
  结果一致，字典序较小缺陷号胜出。
- **D ≤20 缺陷枚举对照朴素循环**：43+ 组种子随机用例（含 n=20），
  位掩码枚举与朴素递归所选集合完全一致且均可行。

## 错误退出码

- exit 19：库存为负（`test/errors.test.js`）
- exit 20：预算币种未知（policy 与 budgetCorrection 事件均覆盖）
- exit 21：重复缺陷号

## 台账与反例

- `test/ledger.test.js`：返工/撤销/更正混合流守恒；删除 `budgetCorrection`
  的篡改台账被审计发现；伪造“撤销回补预算”被拒绝。
- 反例最少缺失约束：超预算方案 → `[["budget"]]`；预算与库存上限双超 →
  `[["budget","stockUseCap"]]`；单产品库存超限 → `[["perProductStock"]]`。
