# hotlib — 可热切换的模块库

仅使用 Go 标准库。

## 语义

- `New(cfg)` 创建库，初始代为第 0 代。
- `Start(fn)` 把任务绑定到**调用时**的当前代并异步运行；任务收到一个
  只能被 `Task.Cancel` 取消的 context——切换代不会取消旧任务。
- `Switch(cfg)` 封口当前代并安装新配置的新代：旧代任务继续运行到结束，
  之后 `Start` 的新任务只绑定新代。
- `WaitOld()` / `OldBarrier()` 只等待**调用时已经封口**的旧代排空；
  调用时仍是当前代的任务、以及调用后新封口的代都不在等待范围内，
  因此 WaitOld 不会被不断产生的新代无限延长。
- `Snapshot()` 返回每代存活任务集合，用于核对。

## 测试

```sh
go test ./...
```

实际结果（go1.27.1 linux/amd64，`go test -count=1 -v ./...`）：

```
--- PASS: TestSwitchKeepsOldGenerationRunning (0.05s)
--- PASS: TestNewTasksBindOnlyToNewGeneration (0.00s)
--- PASS: TestCancelTask (0.00s)
--- PASS: TestWaitOldIgnoresGenerationCurrentAtCall (0.00s)
--- PASS: TestWaitOldNotExtendedByLaterSwitches (1.06s)
--- PASS: TestRandomHistory (5.45s)   # 5 个种子 × 400 步随机 启动/切换/取消/释放/WaitOld
--- PASS: TestConcurrentSmoke (0.01s)
PASS
ok  	hotlib	6.577s
```

`go test -race -count=1 ./...` 同样通过（ok hotlib 7.625s）。
