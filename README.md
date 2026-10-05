# recon-minimize

金融对账差错定位库及 CLI（Node.js 22 标准库，无第三方依赖）。

## 输入

`recon.json`：`{ "expected": [...], "actual": [...] }`，分录字段：

- `entryId`（字符串，同一侧内唯一）
- `account`（字符串）
- `amount`（有限数值；正常分录不得为负）
- `type`：`"normal"` 或 `"reversal"`
- `reversalOf`（仅撤销分录，指向同侧正常分录）

## 对账规则

- 正常分录按 `entryId` 一一匹配：`account`、`amount` 相同则匹配；同 id 同账户金额不同记为金额不符；id 仅在一侧出现记为缺失/多余。
- 撤销分录与同侧原分录配对，金额必须互为相反数；有效对在侧内抵消（净额为零）。
- 未匹配原分录不能被其撤销单独抵消：孤立撤销（原分录不在同侧）判为无效撤销，原分录仍按缺失/多余处理。
- 差异四类：`missing`、`extra`、`amountMismatch`、`invalidReversal`，并给出 `totalImpact`（实际侧相对期望侧的净额影响）。

## 拒绝规则（退出码 1，stderr 含 `INVALID_RECON`）

- 撤销链（`reversalOf` 指向撤销分录或自身）
- 正常分录金额为负
- 同一侧内 `entryId` 重复

## 最小化

证书中的 `minimal` 是能复现完整差异签名的最小分录子集：

- 输入 ≤ 8 条：穷举全部子集，取基数最小、字典序最小（键为 `E:<id>` / `A:<id>` 排序数组）的反例（`exhaustive-lexmin`）。
- 输入 > 8 条：从嫌疑闭包（差异涉及分录 + 无效撤销的同侧原分录）出发贪心归约，保证删除任意单条后差错消失（`greedy-1minimal`）。

`replayHash` 为 `{diffs, minimal, totalImpact}` 规范化 JSON 的 SHA-256，可用于重放校验。

## CLI

```sh
node bin/recon.js minimize recon.json   # 或 npm 链接后 recon minimize recon.json
```

成功输出证书 JSON（退出码 0）；非法输入输出 `INVALID_RECON: ...`（退出码 1）；用法错误退出码 2。

## 测试

```sh
node --test
```

含 ≤ 4 条输入与独立子集枚举的交叉对照、大规模输入的 1-最小性验证、CLI 退出码与证书字段断言。
