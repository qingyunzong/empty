# obs-store — 离线样本观测更正库（CRDT / vector clock / tombstone）

Node.js 22，仅标准库。库在 `src/store.js` + `src/clock.js`，CLI 在 `src/cli.js`。

## CLI

```
obs [--store DIR] init --node A [--nodes A,B,C] [--retention N]
obs [--store DIR] put|correct|delete     # stdin: JSON 行
obs [--store DIR] merge                  # stdin: status --dump 的输出
obs [--store DIR] status [--dump] [--key K]
```

- 输入：JSON 行（每行一个对象，如 `{"key":"obs-1","value":{...}}`；`delete` 只需 `key`）。
- 输出：stdout 每行一个 JSON。错误：stderr 单行 `{"code","msg}`，exit 非 0。
- 存储目录默认 `./.obs`，可用 `--store` 或环境变量 `OBS_STORE` 覆盖。
- 副本同步：`obs --store A status --dump | obs --store B merge`。

## 核心语义

- 每个版本携带 **vector clock** 与 **lamport**；并发判定用 vector clock
  （`isConcurrent`，CLI 见 `status --key` 的 `concurrentPairs`，merge 输出的 `concurrent` 字段）。
- 版本全序 = `(lamport, origin, value)`：与因果一致（lamport 保持 happens-before），
  并发时按 origin 字典序决胜，**绝不使用物理时钟**。
- merge 是半格 join（逐 key 取全序最大 + 版本集并集），天然**可交换、可结合、幂等**。
- `delete` 生成 **tombstone**；`--retention N` 为 lamport 逻辑年龄保留期。
  压缩（GC）条件：所有已知节点的 `seenBy` 时钟覆盖 tombstone 时钟（即所有节点都见过该删除）
  且保留期已过；GC 在 merge 时自动发生。压缩前后可见状态不变。
- 所有更正/删除留痕：记录内保留完整 `history`，磁盘上另有只增审计日志 `log.jsonl`。

## 崩溃原子性

每批写为 `prepare + fsync + commit + fsync` 的 WAL。恢复时只应用有对应 commit 的
prepare，因此一批要么整批可见、要么完全不可见。故障注入钩子（测试用）：
`OBS_FAULT=before-prepare-fsync|before-commit-write|before-commit-fsync|after-commit-fsync`。

## 测试

```
node --test
```

覆盖四个验收场景：三路并发更正的全排列收敛（`test/merge-concurrency.test.js`）、
tombstone 防复活与压缩一致性（`test/delete-gc.test.js`）、重复/乱序投递幂等
（`test/idempotency.test.js`）、fsync 前后 kill 的整批原子性（`test/crash.test.js`），
以及 CLI/错误格式（`test/cli.test.js`）。真实运行输出见 `RESULTS.md`。
