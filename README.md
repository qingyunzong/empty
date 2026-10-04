# queuediag

诊断一段队列操作历史（至多 12 个操作，含调用/返回时间）是否存在满足
真实时间偏序（real-time order）的串行解释，即 FIFO 队列意义下的可线性化判定。

- 重叠（时间区间相交）的操作可以任意排列；
- 未返回（pending）的操作可以省略，或按任意结果补全；
- 可行时输出见证（串行顺序 + 队列状态演化 + 被省略的 pending 操作）；
- 不可行时输出穷尽性结论；
- 两种独立引擎互相核对：
  - **主求解器**（`checker.Solve`）：在真实时间偏序上做带备忘录的 DFS，
    状态为（剩余操作集合, 队列内容），pending 操作有"省略"与"放置"两个分支；
  - **独立核对器**（`checker.BruteForce`）：枚举 pending 操作的每个子集 ×
    每个排列，逐个前缀检查真实时间约束与队列语义，找到合法排列即停止。
- 见证再由 `checker.Validate` 独立校验（真实时间偏序 + FIFO 语义）。

## 输入格式

每行一个操作，`#` 之后为注释；从文件或标准输入读取：

```
enq <value> <call> [ret]        # 入队；省略 ret 表示未返回（pending）
deq <value|empty> <call> <ret>  # 已返回的出队及其结果
deq ? <call>                    # 未返回的出队
```

## 构建与运行

```sh
go build -o queuediag .
./queuediag history.txt     # 或: ./queuediag < history.txt
```

## 测试

```sh
go test ./...
```

实际运行结果（go1.27.1 linux/amd64）：

```
?   	queuediag	[no test files]
ok  	queuediag/checker	0.059s
```

测试覆盖：顺序/重叠可行、真实时间违反、FIFO 违反、空出队、pending 补全与
省略、12 操作可行/不可行/全并发含 pending，以及 5000 个随机历史（2–9 个操作）
上主求解器与独立排列穷举核对器的判定一致性（含见证独立校验）。
