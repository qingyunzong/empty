# 时间线瞬间的可见与回滚

表接入调用可导入的Go包解释时间线，不打开数据文件。瞬间状态只有请求、在途、完成。读取只能看见完成的提交。回滚让被点名的在途瞬间失效，已完成的不受影响。清洁只能删调用方点名的旧文件，不能删仍被完成瞬间引用的文件。时间相等时优先级为完成、回滚、清洁、在途、请求。用时间线重放核对可见性、回滚和清洁保护，期望不得由被测包生成。

## 包结构

- `timeline.go`：纯内存时间线重放器，仅依赖标准库 `sort`，不引入 `os`/`io`
  等任何文件系统包，因此不会打开、读取或删除数据文件。
- `timeline_test.go`：固定时间线测试，期望值按规则人工推导后硬编码。
- `oracle_test.go`：独立编写的参考模型（不同数据结构与控制流），用 200 条
  随机时间线与被测实现交叉核对；另含静态检查，保证非测试源码不触碰文件系统。

## 语义

- 瞬间状态机：`Requested`（请求）→ `Inflight`（在途）→ `Completed`（完成），
  不存在其它状态；被回滚的瞬间以 `Invalid=true` 标记并保留失效前状态。
- 读取只暴露已完成提交：`View.Commits`、`View.VisibleFiles`、`View.IsVisible`。
- 回滚（`NewRollback`）只让被点名且仍在途的瞬间失效；已完成、请求中或未知
  瞬间均不受影响。
- 清洁（`NewClean`）只评估调用方点名的候选文件：仍被任一完成瞬间引用的进入
  `Protected`，其余进入 `Deleted`；包本身不执行真实删除。
- 排序：先按时间戳升序；同时间戳按 完成 > 回滚 > 清洁 > 在途 > 请求，同
  优先级保持调用方给定顺序（稳定排序）。

## 用法

```go
tl := dataeng.NewTimeline([]dataeng.Event{
    dataeng.NewRequest(1, "c1"),
    dataeng.NewInflight(2, "c1"),
    dataeng.NewComplete(3, "c1", []string{"f1"}),
    dataeng.NewClean(4, "clean-1", []string{"f1", "old"}),
})
view, trace := tl.Replay()
_ = view.VisibleFiles() // [f1]：读取只能看见完成提交
_ = view.CleanReports() // old 可删，f1 因被完成瞬间引用而受保护
_ = trace               // 逐事件的瞬间状态，用于重放核对
_ = tl.ReplayUntil(2)   // 只重放到某个时间戳（含同刻全部优先级事件）
```

## 运行核对

```sh
go test -v ./...      # 固定场景 + 独立预言机随机交叉核对
go test -race ./...   # 竞态检测
go test -cover ./...  # 语句覆盖率
```
