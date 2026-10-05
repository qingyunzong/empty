# leasesim — 单机租约模拟库

仅用 Go 标准库实现的租约（lease）模拟库，覆盖授予、续期、权威切换与栅栏（fencing）防护，并提供分区事件脚本的重放验收。

## 设计

- **显式整数时间**：`lease.Time` 为调用方传入的整数逻辑时钟，库内不读取真实时钟。
- **截止排他**：租约有效期为半开区间 `[Start, Expiry)`；`t == Expiry` 时租约已失效。
- **递增栅栏号**：`Manager` 每次授予/续期/切换都使 fence 严格递增。
- **权威切换**：`Switch` 仅在旧租约过期后合法；`ForceSwitch` 可立即切换（如旧持有人被判定死亡），旧持有人不会被通知。
- **栅栏防护**：`Store` 拒绝 fence 低于已见最大值的写入；因此旧持有人即使从未看到失效通知，恢复后也无法写入。
- **事件重放**：`Simulator.Replay` 按脚本执行授予/续期/切换/分区/愈合/写入事件；`Conflicts` 校验不存在"双重合法写入"（两个不同持有人的写入各自落在对方租约有效期内）。

## 结构

- `lease/lease.go` — `Time`、`Lease`、`Manager`（授予/续期/切换）、`Store`（栅栏写入）。
- `lease/events.go` — `Event`、`Simulator`（分区建模 + 重放）、`Conflicts`（验收检查）。
- `lease/lease_test.go` — 核心语义测试（排他截止、栅栏递增、续期、切换、防护）。
- `lease/replay_test.go` — 分区脚本重放验收：无双重合法写入、重放确定性、续期链单一权威、边界时刻。

## 实测结果

环境：go1.27.1 linux/amd64（构建缓存重定向至 /tmp，因默认缓存目录只读）。

```
$ GOCACHE=/tmp/gocache GOPATH=/tmp/gopath go test ./...
ok  	leasesim/lease	0.010s
```

13 个测试全部通过（`go test ./... -v`）：TestGrantIncreasesFence、
TestDeadlineIsExclusive、TestWriteAtExactExpiryRejected、
TestRenewExtendsAndBumpsFence、TestRenewRejectsStaleFenceAndStranger、
TestSwitchOnlyAfterExpiry、TestFencedOutHolderCannotWriteAfterForceSwitch、
TestSameLeaseMayWriteRepeatedly、TestLowerFenceRejected、
TestReplayPartitionNoDoubleLegalWrites、TestReplayIsDeterministic、
TestReplayRenewalChainKeepsSingleAuthority、TestReplayWriteAtExpiryBoundary。
