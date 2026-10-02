# audit-voucher-ledger

审计凭证因果合并库与 CLI。仅使用 Node.js 22 标准库与 `node:test`，无第三方依赖。

## 模型

- 凭证事件：`{ voucherId, version, amount, status, prevHash, clock, hash }`
  - `prevHash`：同一凭证前一版本事件的 SHA-256 哈希（首版本为 `null`）
  - `clock`：向量时钟 `{ replicaId: counter }`
  - `hash`：对事件内容（不含 hash 自身）规范化 JSON 的 SHA-256
- `correct` 必须引用当前已观察的 head 版本：
  - 前置未观察 → `unknown-predecessor`
  - 引用旧版本 / 向量时钟回退 / 版本号不连续 → `stale-clock`
- 多副本合并：同一凭证上无因果关系的 head 若金额或状态不同，标记为 conflict；不同凭证直接合并。
- 审计证书：`{ status, frontier, voucherHashes, conflicts, conflictVouchers, missingDependencies }`；
  存在冲突或缺失依赖时 `status` 为 `invalid`，不给出审计通过结论。

## CLI

```sh
export LEDGER_FILE=ledger.json REPLICA_ID=A   # 可选，默认 ledger.json / replica-1
node cli.js put '{"voucherId":"v1","amount":100,"status":"issued"}'
node cli.js correct '{"voucherId":"v1","amount":120,"status":"issued"}'
node cli.js correct '{"voucherId":"v1","amount":90,"status":"settled","baseVersion":2}'
node cli.js merge other-ledger.json
node cli.js audit
node cli.js get v1
```

输入输出均为 JSON；错误输出 `{"error":"code"}` 且退出码为 1。

## 测试

```sh
node --test --test-reporter spec
```

测试枚举两副本三条凭证事件（`e1 < e2`、`e1 < e3`、`e2 ∥ e3`）偏序的全部线性扩展，
并用独立的参考算法（纯 prevHash 图遍历）对照版本可达性、head 集合与冲突判定。
