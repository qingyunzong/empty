# 批量结算清分库（settlement-clearing）

Node.js 22，仅标准库，事件溯源架构。状态持久化为 JSONL 事件日志，输入输出均为 JSON 文件。

## 领域模型

- **批次（batch）**：批次号 `batchId` + 初始分录（版本 1）。创建时按分录净额冻结总额 `frozenTotal`。
- **更正包（correction）**：必须基于当前版本（`version === 当前版本 + 1`），否则拒绝并返回
  `VERSION_CONFLICT`，且不改账。更正类型：`add`（新增分录）、`reverse`（冲减已有分录）、
  `adjust`（调整分录金额到 `newAmount`）。更正在应用时被物化为带符号增量（delta），
  因此历史事件可按任意顺序重放并得到相同的最终净额与证书哈希。
- **确认（confirm）**：对最终版本生成分账证书（各账户净额 + SHA-256 规范哈希）。
- **撤销（cancel）**：确认前撤销释放冻结（`release`）；确认后撤销生成反向补偿分录
  （`compensate`），历史事件全部保留，所有账户净余额归零。
- **幂等**：变更命令必须携带 `requestId`。同一 `requestId` 重复提交返回原始结果，
  不追加事件、不改账。

## CLI

```sh
node cli.js <command> --input <in.json> --store <store.jsonl> [--output <out.json>]
```

命令：`create-batch` | `apply-correction` | `confirm` | `cancel` | `status`

- 成功：退出码 0，结果 JSON 写到 stdout 或 `--output` 文件。
- 失败：退出码 1，标准错误 JSON 写到 stderr：`{"error":{"code":"...","message":"..."}}`。

### 输入示例

```json
// create-batch
{"requestId":"r1","batchId":"B1","entries":[{"entryId":"e1","account":"alice","amount":1000}]}
// apply-correction（version 必须等于当前版本 + 1）
{"requestId":"r2","batchId":"B1","version":2,"corrections":[{"type":"adjust","entryId":"e1","newAmount":900}]}
// confirm / cancel
{"requestId":"r3","batchId":"B1"}
// status
{"batchId":"B1"}
```

金额一律为整数（最小货币单位）。

## 错误码

`INVALID_INPUT` `BATCH_EXISTS` `BATCH_NOT_FOUND` `BATCH_NOT_OPEN` `BATCH_CANCELLED`
`VERSION_CONFLICT` `DUPLICATE_ENTRY` `ENTRY_NOT_FOUND` `UNKNOWN_COMMAND` `STORE_ERROR` `INTERNAL`

## 测试

```sh
node --test
```

验收覆盖：连续两次更正后按最终净额入账；乱序重放全部历史得到相同证书；确认后撤销使
所有账户净余额为零且审计链完整；旧版本重复提交返回 `VERSION_CONFLICT`；同 `requestId`
重复提交返回原结果。暴力对照测试对 1–8 条分录、3 个版本的全部更正符号组合
（共 87380 个场景）用独立算法求净额与哈希，与被测实现逐一比对。
