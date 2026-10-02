# journal-sync — 核心账务夜间同步（journal.ndjson → 结算库）

仅使用 Node.js 22 标准库与 `node:test`，单机离线，无网络与外部服务。

## 命令

```bash
node cli.js scan   --journal journal.ndjson --snapshot snap.json --changeset cs.json
node cli.js apply  --changeset cs.json --db db.json --checkpoint cp.json --cert cert.json [--batch 1000]
node cli.js resume --changeset cs.json --db db.json --checkpoint cp.json --cert cert.json [--batch 1000]
node cli.js cert   --checkpoint cp.json --db db.json --cert cert.json
```

- `scan`：对比上一夜快照，把新增/修改/删除捕获为变更集（每行带 SHA-256 行哈希）。
- `apply`：按批幂等落库；同事务键后写覆盖前写（按 `seq` 最大者生效），撤销事件可回指
  （`undo.ref`）；重复撤销同一交易只生效一次并记录 `DUPLICATE_UNDO` 冲突标记。
- `checkpoint`：每批提交后原子写入已提交位点、行哈希、批次数、覆盖区间、状态哈希。
- `cert`：输出已提交行哈希的 Merkle 根与覆盖区间 `[minSeq, maxSeq]`，供审计核验。
- `resume`：崩溃恢复——apply 写库后未写 checkpoint 的批次重做（幂等，结果一致）；
  checkpoint 已写但未写 cert 时不重做，仅补发证书。

## 崩溃点语义

1. apply 写库后、checkpoint 写前崩溃 → 该批未提交，恢复时重做（事件集归并幂等）。
2. checkpoint 写后、cert 写前崩溃 → 已提交，恢复时不重做（`redone: 0`），仅补 cert。

所有持久化写入均为「临时文件 + fsync + rename」原子替换，无撕裂状态。

## 金额与错误

- 金额一律为整数分；非整数或负数金额拒绝（`INVALID_AMOUNT`）。
- 最终余额为负即错误（`NEGATIVE_BALANCE`）。
- 缺行（空行或 seq 缺口，`MISSING_LINE`）、坏哈希（`HASH_MISMATCH`）等业务错误：
  退出码 2，stderr 输出单行 JSON `{"error":{"code","message","details"}}`。

## 测试

```bash
node --test test/*.test.js   # 单元/恢复/枚举/错误测试
bash scripts/e2e_crash.sh    # 真实 kill -9 端到端验证（1 万行，3 次随机崩溃）
```

注：本工作区沙箱禁止 Node 派生子进程，因此 `node:test` 内的崩溃用「在持久化写入
之间抛出异常」模拟（恢复路径只读磁盘状态，语义等价）；真实 `kill -9` 由
`scripts/e2e_crash.sh` 覆盖，两者输出均见 RESULTS.md。
