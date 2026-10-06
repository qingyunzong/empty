# execcache

内容寻址的执行缓存库。

## 语义

- **键构成**：缓存键由任务输入（`Inputs`）、源码（`Source`）、命令（`Command`）
  与环境摘要（`Env`）共同哈希得出；任一摘要变动都会产生新键，绝不复用旧结果。
- **同键共享**：并发或后续的同键调用共享同一次执行与其结果。
- **失败不缓存**：执行出错（含非零退出码）不会写入缓存，下次同键调用重新执行。
- **取消传播**：等待者引用计数——仅当最后一个等待者取消时，才取消上游执行；
  此后新调用会发起全新执行。

## 用法

```go
c := execcache.New()
req := execcache.Request{
    Inputs:  map[string]string{"main.txt": "..."},
    Source:  "package main // v1",
    Command: []string{"sh", "-c", "build"},
    Env:     map[string]string{"MODE": "fast"},
}
res, err := c.Do(ctx, req, execcache.CommandExecutor{})
```

`Executor` 接口可注入自定义执行器；测试中以受控 promise 执行器
（`cache_test.go` 中的 `promiseExecutor`）确定性核验并发命中与版本切换。

## 测试

```sh
go test ./...
```
