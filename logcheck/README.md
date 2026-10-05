# logcheck

历史日志一致性检查 CLI：校验三个节点的交付日志是否满足**同序前缀一致**
（任意两节点的日志，一方是另一方的前缀）。仅使用 Go 标准库。

## 语义

- **已崩溃节点允许短前缀**：`status <node> crashed` 的节点条目更少不算冲突；
  但已交付条目若与其他节点分歧，仍照常报告。
- **未知状态不得认作故障**：`unknown` 仅作展示，既不算故障，也不豁免分歧。
- **最早冲突报告**：冲突时输出最小分歧下标及两份来源（两个节点名与各自取值），
  同下标多对冲突时按节点名字典序取最小对，结果确定。

## 日志文件格式

```
status <node> <ok|crashed|unknown>
entry  <node> <value>     # 同一节点按交付顺序出现
```

## 用法

```
logcheck check <file>            # 全对比较模型（参考模型）
logcheck check -incr <file>      # 增量追加模型（逐条流式检查）
logcheck check -verify <file>    # 两模型交叉核对，结果必须一致
logcheck append <file> <node> <value>   # 追加一条 entry 并增量核对
```

退出码：0 一致；1 发现冲突；2 用法/解析错误；3 增量与全比较模型不一致。

## 增量模型

`IncrChecker` 在每条 `Append` 到达时，仅将新下标与其他节点同下标条目比较；
任意一对节点的下标 k 比较恰好在较晚一次追加到达时发生一次，因此与
`FullCheck`（两两全比较参考模型）等价。`TestIncrementalMatchesFull` 用
2000 组随机三节点日志（随机分歧、随机截断、随机交错追加顺序）核对两模型
结果完全一致。

## 测试

`go test ./...` 实际运行结果（go1.27.1 linux/amd64）：

```
=== RUN   TestConsistentWithCrashedShortPrefix      --- PASS
=== RUN   TestUnknownStatusNotTreatedAsFault        --- PASS
=== RUN   TestEarliestConflictAndTwoSources         --- PASS
=== RUN   TestCrashedNodeDivergenceStillReported    --- PASS
=== RUN   TestUnknownNodeDivergenceStillReported    --- PASS
=== RUN   TestParseErrors                           --- PASS
=== RUN   TestIncrementalMatchesFull                --- PASS
=== RUN   TestIncrementalStreamingMatchesFull       --- PASS
PASS
ok  	logcheck	0.018s
```
