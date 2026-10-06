# breaker

三态熔断器（关闭 / 开启 / 半开），带代际（generation）隔离的结果上报。

## 状态机

- **关闭**：请求全部放行；连续失败达到 `FailureThreshold` 后进入开启。
- **开启**：`Acquire` 明确返回 `ErrOpen` 拒绝普通请求；`OpenDuration`
  （由可注入的 `Clock` 计量）届满后转入半开。
- **半开**：最多放行 `MaxProbes`（K）个并发探测，超出返回
  `ErrProbeLimit`；探测成功达到 `RequiredSuccesses` 次后关闭，
  任一探测失败立即重新开启。

## 代际语义

每次状态迁移都会递增代际计数。`Permit` 携带签发时的代际，只有本代际
的结果会影响状态：上一代半开探测的迟到成功不会关闭新开启的代际，
迟到失败也不会污染新代际的失败计数。

## 用法

```go
b := breaker.New(breaker.Options{
    FailureThreshold:  3,
    OpenDuration:      time.Minute,
    MaxProbes:         2, // K
    RequiredSuccesses: 2,
    Clock:             myClock, // 可注入受控时钟；nil 用真实时间
})

p, err := b.Acquire()
if err != nil { /* ErrOpen / ErrProbeLimit */ }
// ... 发起请求 ...
p.Success() // 或 p.Failure()，恰好调用一次
```

## 测试

```sh
go test ./...
```
