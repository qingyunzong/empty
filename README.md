# formal — 流关联时态查找库

供流引擎关联（temporal join）算子调用的 Go 时态查找库，按主键的有效期
区间与事件时间水位，为每个事件选择其事件时刻的精确版本，并处理迟到事件
与撤回。

## 语义边界

- 版本可见区间为半开 `[ValidFrom, ValidTo)`：`ValidFrom` 闭、`ValidTo`
  开；开放区间用 `ValidTo == math.MaxInt64` 表示（写入时传 0 即开放）。
- 查找 `Lookup` / 探测 `Probe` 只选择事件时刻 `t` 已生效且未过期的版本，
  即 `ValidFrom <= t < ValidTo`；未来生效的版本（`ValidFrom > t`）即使已经
  写入也不会被选中。
- 水位 `watermark` 与允许迟到 `allowedLateness` 确定接收下界
  `horizon = watermark - allowedLateness`，该边界为闭：`t >= horizon` 接收，
  `t < horizon` 丢弃。首个水位到达前接收所有非负时间戳。
- 迟到但仍在允许期内的写入会修订已有探测结果：以追加新 `Emission` 的方式
  输出修订，历史输出永不就地改写（append-only journal）；墓碑版本产生
  `Deleted=true` 的撤回发射。
- 同一 `eventID` 重放返回当前发射且不产生重复记录。
- `Advance` 推进水位并回收不可再观测的版本区间与超出 horizon 的探测；
  窗口内的探测继续保留以便迟到写入修订。

## 组件

- `temporal.go`：`LookupStore[V]`，按主键维护半开区间版本切片，二分查找
  事件时刻版本，线程安全（`sync.RWMutex`）。
- `naive.go`：`NaiveStore[V]`，朴素参考实现——保留全历史版本，每次写入后
  整体重排重建区间，每次查找对全部历史版本做 O(n) 线性扫描。
- `replay.go`：事件序列重放框架 `Replay`，把同一 `Op` 序列喂给两个引擎，
  逐步比对 lookup、probe、丢弃判定、sweep 修订与完整 journal。

## 验证

```
go test ./...          # 单元测试 + 200 组随机差分重放 + 不变量校验
go test -race ./...    # 并发竞态检测
go test -cover ./...   # 语句覆盖率（约 92%）
```

随机重放交错执行 upsert / delete / probe / lookup / watermark 推进 /
sweep，时间戳刻意聚集在水位与 horizon 边界附近；不变量测试额外保证：
保留区间始终半开且连续、探测永不选中未生效版本、journal 前缀永不被改写。
