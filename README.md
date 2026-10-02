# settlement-clearing

批量结算清分库与 CLI。Node.js 22，仅使用标准库与 `node:test`。

## 模型

- 批次（`batchId`）创建时携带多条账户分录并冻结总额（`frozenTotal`），初始版本为 1。
- 更正包必须基于当前版本（`baseVersion === version`），否则返回 `VERSION_CONFLICT` 且不改账。
  更正算子：`add`（新增分录）、`reverse`（冲减已有分录）、`adjust`（调整分录金额），
  全部以追加差异分录方式入账，历史分录永不修改。
- `confirm` 按最终版本净额生成分账证书（`nets` 按账户排序后的规范化 JSON 的 SHA-256）。
- `revoke`：确认前撤销释放冻结；确认后撤销生成反向补偿分录（`COMPENSATION_APPLIED`），
  所有账户净额归零，审计链完整保留。
- 幂等：每个请求携带 `requestId`，同批次同版本重复提交返回原结果，不追加事件。
- 状态以 JSONL 事件日志持久化；事件自包含，乱序重放整个历史得到相同证书
  （净额求和与顺序无关，证书由确认事件承载）。

## CLI

```sh
node bin/settle.js <create|correct|confirm|revoke|status|certificate|audit> \
  --input in.json [--output out.json] [--state state.jsonl]
```

- 输入为 JSON 文件；成功时结果 JSON 写入 `--output` 并打印到 stdout，退出码 0。
- 失败时标准错误 JSON（`{"ok":false,"error":{"code","message"}}`）打印到 stderr，退出码 1。

示例：

```sh
node bin/settle.js create  --input examples/create.json  --output out1.json --state s.jsonl
node bin/settle.js correct --input examples/correct.json --output out2.json --state s.jsonl
node bin/settle.js confirm --input examples/confirm.json --output out3.json --state s.jsonl
```

## 错误码

`VERSION_CONFLICT` `BATCH_NOT_FOUND` `BATCH_EXISTS` `INVALID_STATE`
`ENTRY_NOT_FOUND` `VALIDATION_ERROR` `INVALID_INPUT` `USAGE`

## 测试

```sh
node --test
```

- `test/acceptance.test.js`：连续两次更正后按最终净额入账；乱序重放得到相同证书；
  确认后撤销净额归零且保留审计链；旧版本重复提交返回 `VERSION_CONFLICT`；幂等重放。
- `test/bruteforce.test.js`：独立暴力算法对不超过 8 条分录、3 个版本的所有更正
  符号组合求净额与哈希，与被测实现对照。
- `test/cli.test.js`：CLI 的 JSONL 持久化、幂等、错误 JSON 与退出码。
