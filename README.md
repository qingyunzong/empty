# logcompact

支持压缩到指定提交版本的事务日志库（Go）。

## 模型

- 日志只追加，记录类型：`Begin` / `Update` / `Commit` / `Abort`，每条记录带单调递增的 LSN 和同事务前驱指针 `PrevLSN`（恢复撤销链）。
- `Commit` 返回的 LSN 即**提交版本**，可作为压缩水位（horizon）。
- 压缩规则（`Log.Compact(horizon, readers)`）：丢弃所有 LSN ≤ horizon 且不再被需要的记录，其余全部保留，并为每条保留记录输出原因：

| 原因 | 含义 |
| --- | --- |
| `beyond-horizon` | LSN 高于水位，不可压缩 |
| `checkpoint-base` | 该 key 在水位处可见的最新已提交更新，承载压缩后的提交状态 |
| `active-reader` | 某活跃读者快照处可见的最新已提交更新 |
| `pending-txn-recovery` | 所属事务在水位处尚无结局（未提交/未中止），恢复需要完整记录链 |
| `commit-marker` | 被保留更新所属事务的提交记录，恢复据此判定更新生效 |

- 水位只能取已知提交版本且不可回退，否则返回 `ErrInvalidHorizon`。

## 代际防旧释放

读者通过 `ReaderRegistry.Acquire(snapshot)` 注册，获得 `{ID, Generation, Snapshot}` 令牌。槽位 ID 会被回收复用，但每次 `Acquire` 都会递增该槽位的代际号；`Release` 校验令牌代际，过期令牌（重复释放、复用前的旧令牌）一律返回 `ErrStaleRelease`，且不会误删占用同一槽位的新读者。

## 恢复模型核验

`Recover` / `RecoverAt` 重放日志得到提交状态与未决事务链。`random_test.go` 以固定种子生成随机事务轨迹（begin/update/commit/abort、读者注册/释放、故意混入旧令牌释放、随机压缩），每次压缩后断言：

- 压缩日志与全量日志恢复出的提交状态一致；
- 未决事务集合及其 `PrevLSN` 链完全一致；
- 每个活跃读者的快照读在两个模型下一致；
- 每条保留记录都带有至少一个保留原因，被丢弃记录均不高于水位。

## 运行

```sh
go test ./...
```
