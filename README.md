# settlement-ledger

结算账户成员变更库与 CLI。Node.js 22，仅标准库与 `node:test`，无第三方依赖。

## 模型

- 账户新增、移除、转账、支付都是因果事件，携带向量时钟，追加到账本事件日志。
- `remove-account` 产生带纪元（epoch）的墓碑；账户余额非零时拒绝（`balance-not-zero`），
  必须有因果上可见的转平事件（transfer/pay）把余额清零。
- 支付给已移除账户：因果上发生在移除之前的支付保留在历史中供审计；之后的拒绝（`account-removed`）。
- 同名账户重新加入生成新化身 ID（如 `alice#2`），不继承旧墓碑前的余额，余额从零开始。
- 并发（互不观察）的移除与支付/转账在 `merge` 时判定为 `conflict`，合并不落盘。

## CLI

```sh
node cli.js add-account <name> [--file ledger.json] [--replica id]
node cli.js remove-account <name>
node cli.js transfer <from> <to> <amount>
node cli.js pay <name> <amount>
node cli.js merge <other-file>
node cli.js account <name>
```

- 输出为 JSON；成功 `{"ok":true,...}`，退出码 0。
- 错误输出 `{"error":"code"`}，退出码 1。错误码：`balance-not-zero`、`account-removed`、
  `no-such-account`、`account-exists`、`invalid-amount`、`invalid-arguments`、`conflict`、`unknown-command`。
- `--file` 指定账本文件（默认 `ledger.json`）；`--replica` 在派生账本副本时指定副本 ID。

## 库

`src/ledger.js` 导出：`createLedger`、`addAccount`、`removeAccount`、`transfer`、`pay`、
`mergeLedgers`、`accountState`、`findConflicts`、`happensBefore`、`areConcurrent`、
`loadLedger`、`saveLedger`、`LedgerError`。

## 测试

```sh
node --test --test-reporter spec
```

在限制子进程 stdio 的沙箱中，可加 `--experimental-test-isolation=none` 获得逐条用例输出。

测试包含：三条验收流程；两账户三事件（pay / transfer / remove）全部 6 种先后排列，
与独立参考余额/纪元表对照；并发移除与支付的 merge 冲突；合并幂等性。
