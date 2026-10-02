# journal-settlement-ledger

财务夜间批处理：把核心账务 `journal.ndjson` 同步到结算库，崩溃后可续跑，并产出可核验证书。
仅使用 Node.js 22 标准库与 `node:test`，单机离线，无网络与外部服务。

## 命令

```
node cli.js scan   --journal journal.ndjson --dir .state
node cli.js apply  --journal journal.ndjson --dir .state [--batch N]
node cli.js resume --journal journal.ndjson --dir .state [--batch N]
node cli.js cert   --journal journal.ndjson --dir .state
```

- `scan`：对比上一快照，把新增/修改/删除捕获为变更集（`changeset.ndjson`），并初始化 checkpoint。
- `apply`：按批幂等落库；每批先写 `db.json` 再写 `checkpoint.json`（均为 tmp+fsync+rename 原子写），最后签发 `cert.json`。
- `resume`：崩溃恢复。`db` 领先 `checkpoint`（写库后未写 checkpoint）=> 未提交，幂等重做该批；`checkpoint` 已提交而 `cert` 缺失 => 已提交不重做，仅补发证书。
- `cert`：输出覆盖区间 `[from,to]` 内日志行哈希的 Merkle 根、行哈希链与批次数。

## 语义

- 同一事务键后写覆盖前写；撤销事件（`{"id":"u1","undo":"t1"}`）可回指。
- 重复撤销同一交易只生效一次，后续撤销留冲突标记（`duplicate-undo`）。
- 金额一律整数分（`amount_cents`），负余额为错误。
- 缺行 / 坏哈希 / 坏 JSON / 非整数金额：退出码 2，stderr 输出 JSON 错误。

## 测试

```
node --test test/*.test.js
```

状态目录文件：`snapshot.json`、`changeset.ndjson`、`changeset.meta.json`、`db.json`、`checkpoint.json`、`cert.json`。
崩溃注入（仅测试用）：环境变量 `LEDGER_CRASH_AT=db:<k>|ckpt:<k>|pre-cert`。
