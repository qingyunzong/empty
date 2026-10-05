# mirrorlib — 镜像文件库

三个本地副本（`replica-0/1/2`）保存带版本与 SHA-256 摘要的记录，仅使用 Go 标准库。

## 规则

- **多数同版本才成功**：`Read` 只有在 ≥2/3 副本持有同一有效版本时才返回数据，否则返回 `ErrNoMajority`。
- **读修复不覆盖更高版本**：修复仅写入落后/损坏/缺失的副本；持有更高版本的副本保留并记为 `kept-higher-version`。
- **严格递增写**：`Write` 的版本必须大于当前所有有效副本的最高版本，否则返回 `ErrVersionNotIncreasing`。
- **修复途中写入**：修复阶段在锁内重读副本，发现期间被并发写入（版本已不低于多数版本）则跳过并记为 `concurrent-write-during-repair`。

## 证据与验证

- `Read` 返回 `ReadResult.Anomalies`，枚举 `corrupt` / `missing` / `stale` / `repaired` / `kept-higher-version` / `concurrent-write-during-repair`。
- `Verify(key)` 返回 `Evidence`：每个副本的状态、版本、摘要，以及本存储应用过的逐副本版本历史；`Monotonic` 校验所有副本版本历史单调不减。

## 测试结果（实际运行）

```
$ go test ./...
ok  	mirrorlib	0.053s
$ go test -race ./...
ok  	mirrorlib	1.112s
```

10 个测试全部通过：多数派读写、非递增版本拒绝、损坏/缺失/过期副本的枚举与修复、
无多数派失败、修复保留更高版本、修复途中并发写入、Verify 证据与单调性、重开后数据与版本规则保持。
