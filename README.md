# formal：可嵌入的 Go 配置热加载库

`formal` 把一个配置版本建模为一组完整的命名部件（`Part`）。候选版本先在旁边构建并校验，只有全部校验通过才通过一次原子指针交换发布；任一部分失败则丢弃候选、保留旧版本。请求通过 `Acquire` 固定进入时的版本，切换期间不会看到新旧部件混合。

## 核心保证

- **全有或全无**：`Apply` 先运行所有部件校验器，再运行整体配置校验器。任何错误都会返回 `*ValidationError`，当前版本和版本号保持不变，只触发拒绝回调。
- **原子切换**：候选 `Version` 完全构建并校验后才写到 `atomic.Pointer`，读请求只会看到切换前或切换后的完整版本。
- **在途请求固定版本**：`Acquire` 返回的 `Snapshot.Version` 在 `Release` 前始终保持进入时的版本，后续切换不影响它。
- **切换不阻塞请求**：读取路径无锁；写者串行化，发布是一次指针交换。
- **失败后继续监听**：`Watch`/`WatchUpdates` 遇到拒绝只记录并继续，后续修正后的配置仍可发布。
- **版本表可核对**：成功发布才消耗版本号，初始版本为 1；被拒绝的候选不会产生版本。

## 基本用法

```go
manager, err := formal.NewManager(
    []formal.Part{
        {Name: "server", Value: "127.0.0.1:8080"},
        {Name: "timeout", Value: 5 * time.Second},
    },
    formal.WithValidator("timeout", func(part formal.Part) error {
        timeout := part.Value.(time.Duration)
        if timeout <= 0 {
            return errors.New("timeout must be positive")
        }
        return nil
    }),
    formal.WithConfigValidator(func(version *formal.Version) error {
        if _, ok := version.Get("server"); !ok {
            return errors.New("server part is required")
        }
        return nil
    }),
)
if err != nil {
    return err
}
```

每个请求在入口处固定版本：

```go
func handle(manager *formal.Manager) error {
    snapshot := manager.Acquire()
    defer snapshot.Release()

    server, _ := formal.Lookup[string](snapshot.Version, "server")
    timeout, _ := formal.Lookup[time.Duration](snapshot.Version, "timeout")
    return serve(server, timeout)
}
```

发布候选版本：

```go
next, err := manager.Apply([]formal.Part{
    {Name: "server", Value: "127.0.0.1:9090"},
    {Name: "timeout", Value: 3 * time.Second},
})
if err != nil {
    // 任一部分失败：next == nil，旧版本保持发布状态。
    return err
}
```

## 监听配置变更

`Watch` 接收任意 `formal.Source`。`FileSource` 用内容哈希轮询文件，文件变化时才产生更新；默认按 JSON 对象解码，每个顶层成员对应一个 `Part`。

```go
source := &formal.FileSource{
    Path:     "/etc/my-service/config.json",
    Interval: 200 * time.Millisecond,
}

ctx, cancel := context.WithCancel(context.Background())
defer cancel()

manager.OnReject(func(rejection formal.Rejection) {
    log.Printf("config rejected, keeping v%d: %v",
        manager.Current().ID(), rejection.Err)
})

if err := manager.Watch(ctx, source); err != nil && !errors.Is(err, context.Canceled) {
    return err
}
```

更新结构如下：

```go
type Update struct {
    Parts []Part
    Token string // 可选；与上次成功发布的 token 相同则跳过
    Err   error  // 源或解码错误；记为拒绝，不改当前版本
}
```

## 事件序列穷举验证

`exhaustive_test.go` 枚举所有合法事件序列，并与“朴素版本表”逐步对照：

- 事件包括 `start(request)`、`read(request)`、`end(request)`、`apply(candidate)`。
- 候选包括两个合法版本和一个“新 `a` + 非法 `b`”的版本，用于制造部分失败。
- 朴素模型只是一个版本表切片、当前行下标，以及每个请求启动时记录的行号；没有原子操作或快照逻辑。
- 每条轨迹每一步都核对：当前版本行、请求启动时所见版本、读取时所见版本（必须仍是进入时的版本）、发布/拒绝计数、在途请求数和被旧版本占用的快照数。
- 因为 `apply` 总是合法，任何较短轨迹都能延长到最大深度，所以检查所有最大深度轨迹即覆盖所有前缀。

当前覆盖：

- 单请求全部合法序列，深度 9：691,903 条。
- 双请求全部合法序列，深度 7：198,593 条。

此外 `TestConcurrentReadersNeverSeeMixedVersions` 在真实并发下持续切换合法/非法版本，所有读取都断言 `a`、`b` 来自同一版本；建议配合竞态检测运行。

## 测试

```sh
go test ./...
go test -race -run 'TestConcurrent|TestWatch|TestFileSource|TestSnapshot|TestPartial' ./...
go test -short ./... # 跳过穷举，保留快速测试
```
