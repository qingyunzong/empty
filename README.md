# shardmig

键区间分片迁移处理库（仅使用 Go 标准库）。

## 语义

- **区间模型**：半开区间 `[Start, End)`，**边界键归右区间**——等于分割点的键属于右侧区间。空 `Start`/`End` 表示负/正无穷。
- **迁移协议**（`BeginMigration` → `Commit`）：
  - Begin 在两个分片的锁内原子完成：新分片世代 +1、区间内的 KV 状态与**已处理消息 ID 一并迁入**新分片、旧分片安装转发规则。
  - **迁移期间**（Begin 与 Commit 之间）路由表仍指向旧分片，**旧分片把落在迁移区间的消息转发到新分片**，以新世代提交。
  - **只新世代可提交**：携带旧世代的直接提交被拒绝（`ErrStaleGeneration`）。
  - Commit 切换路由表与区间归属；旧分片保留转发规则，迟到的旧路由请求仍被转发。
- **离散消息去重**：已处理消息 ID（`processed`）在提交时记录，重复投递不再产生业务效果；ID 随区间迁移，跨分片重投仍去重。
- **中断验收**：业务效果在暂存副本上执行，与已处理 ID 在同一临界区内**原子提交**；提交前中断则两者都不落盘，重试后只产生**单次业务效果**且**状态完整**。

## API 摘要

- `NewCluster()` / `AddShard(id, ranges...)`：集群与分片登记（区间不得重叠）。
- `Route(key) (shardID, gen, err)`：查询键的当前路由与世代。
- `Accept(shardID, gen, msg)`：在指定分片以给定世代验收消息；必要时自动转发。
- `BeginMigration(from, to, rng)` / `Migration.Commit()`：两阶段区间迁移。
- `SetInterruptHook(fn)`：测试钩子，在提交前注入中断。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64。

`go test ./...`：

```
ok  	shardmig	0.006s
```

`go test -race -count=1 -v ./...`：

```
=== RUN   TestBoundaryKeyBelongsToRightInterval
--- PASS: TestBoundaryKeyBelongsToRightInterval (0.00s)
=== RUN   TestMigrateMovesStateAndProcessedIDs
--- PASS: TestMigrateMovesStateAndProcessedIDs (0.00s)
=== RUN   TestForwardingAndNewGenerationDuringMigration
--- PASS: TestForwardingAndNewGenerationDuringMigration (0.00s)
=== RUN   TestLateRequestForwardedAfterCommit
--- PASS: TestLateRequestForwardedAfterCommit (0.00s)
=== RUN   TestInterruptedAcceptExactlyOnce
--- PASS: TestInterruptedAcceptExactlyOnce (0.00s)
=== RUN   TestDuplicateMessageSingleEffect
--- PASS: TestDuplicateMessageSingleEffect (0.00s)
=== RUN   TestConcurrentDuplicateAccepts
--- PASS: TestConcurrentDuplicateAccepts (0.00s)
=== RUN   TestProcessedIDsDeduplicateAcrossShards
--- PASS: TestProcessedIDsDeduplicateAcrossShards (0.00s)
=== RUN   TestMigrationValidation
--- PASS: TestMigrationValidation (0.00s)
=== RUN   TestAcceptAfterMigrationUsesNewGeneration
--- PASS: TestAcceptAfterMigrationUsesNewGeneration (0.00s)
PASS
ok  	shardmig	1.017s
```
