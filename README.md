# cmdwrap

Go 命令包装库：运行外部命令并记录完整生命周期（启动、stdout/stderr、退出、超时）。

## 语义

- **输出记录**：stdout/stderr 分别捕获，达到 `MaxOutputBytes` 上限后继续排空子进程输出（防止管道写满死锁），并将对应流标记为 truncated。
- **终态唯一**：每次运行恰好记录一个终态（`exited` / `signaled` / `timed_out` / `canceled` / `start_failed`），进程退出、超时、取消三者竞态时**先发生的终态获胜**。
- **成功判定**：`Success()` 仅当进程正常退出且退出码为 0；未记录到退出（信号、超时、取消、启动失败）绝不视为成功。

## 用法

```go
res := cmdwrap.Run(ctx, cmdwrap.Options{
    Name:           "mytool",
    Args:           []string{"--verbose"},
    Timeout:        30 * time.Second,
    MaxOutputBytes: 1 << 20, // 每个流的上限
})
if res.Success() { /* ... */ }
fmt.Println(res.State, res.ExitCode, res.StdoutTruncated, res.Duration())
```

## 测试

```sh
go test ./...
```

夹具通过重执行测试二进制（helper process）覆盖：大输出截断且不死锁、信号退出（`ExitCode == -1`）、超时强杀、取消、退出先于取消获胜等场景。
