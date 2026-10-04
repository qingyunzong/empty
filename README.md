# tickcache

按固定逻辑 tick 累计访问次数的缓存库（仅使用 Go 标准库）。

## 语义

- **分代统计**：每个 tick 的访问次数累计在一个统计代（generation）中。
- **原子换代**：`Tick` 通过 `atomic.Pointer.Swap` 原子替换当前统计代。
- **迟到写入**：换代前已加入旧代的写入仍记入原代；`Tick` 先关闭旧代
  （拒绝新写入者加入），再用 `WaitGroup` 等待全部迟到写入完成后才结算。
- **结算**：旧代计数合并进各键的频次（仅统计完成的代）。
- **逐出顺序**：频次低 → 最后访问 tick 早 → 键小。新键准入前在既有键中
  选出受害者。

## 测试

- `TestEvictLowestFrequency` / `TestEvictEarliestLastAccess` /
  `TestEvictSmallestKey`：逐出策略三条规则的确定性验证。
- `TestFixedTickAccumulation`：跨 tick 固定累计逻辑。
- `TestBarrierRaceAgainstEventLog`：屏障（共享 `start` channel）同时释放
  32 个访问协程（各 500 次访问）与 1 个结算协程（300 次 `Tick`），制造
  结算与访问的竞争；以每协程私有事件日志汇总为完整事件统计参照，校验
  结算钩子累计值、键级频次与快照三者与参照完全一致，且每个代恰好结算
  一次。

## 实际运行结果

```
$ go test ./... -v
=== RUN   TestEvictLowestFrequency
--- PASS: TestEvictLowestFrequency (0.00s)
=== RUN   TestEvictEarliestLastAccess
--- PASS: TestEvictEarliestLastAccess (0.00s)
=== RUN   TestEvictSmallestKey
--- PASS: TestEvictSmallestKey (0.00s)
=== RUN   TestFixedTickAccumulation
--- PASS: TestFixedTickAccumulation (0.00s)
=== RUN   TestBarrierRaceAgainstEventLog
--- PASS: TestBarrierRaceAgainstEventLog (0.01s)
PASS
ok  	tickcache	0.017s

$ go test ./... -race -count=5
ok  	tickcache	1.513s

$ go test ./... -run TestBarrierRaceAgainstEventLog -count=20
ok  	tickcache	0.269s
```

（环境：go1.27.1 linux/amd64；因默认构建缓存目录只读，运行时设置了
`GOCACHE=/tmp/gocache`。）
