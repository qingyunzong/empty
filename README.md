# frameidx

帧索引库（Go 标准库实现，无第三方依赖）。

## 设计

- `Frame` 显式记录：参考帧 ID 列表 `Refs`、解码时间 `DTS`、显示时间 `PTS`。
- `NewIndex` 建库并全图校验：重复 ID、缺参考（`MissingRefs`）、依赖环（`Cycles`，三色 DFS）。
- `SeekInterval(startPTS, endPTS)` 按显示区间取目标帧，沿参考边 BFS 求**最小依赖闭包**
  （目标帧 + 全部传递参考，不多不少）；闭包内缺参考与环照常报告，有环则不出证书。
- 解码序由依赖图 + DTS 决定（Kahn 拓扑排序，(DTS, ID) 堆序），**绝不按 PTS 当解码序**；
  测试 `TestDisplayTimeIsNotDecodeOrder` 证明 PTS 排序的证书无法通过校验。
- `Certificate.Order` 为拓扑证书；`Verify` 用独立的**全图 DFS 模型**（`dfsReachable`，
  与闭包计算不共享代码）核对：集合精确相等（完备 + 最小）、每个帧的参考均在其之前
  （依赖偏序的合法线性扩展）。

## 测试结果（实际运行）

```
$ go vet ./... && go test ./... -count=1
ok  	frameidx	0.014s
```

9 个测试全部通过：B 帧乱序 seek、PTS≠解码序、最小闭包、缺参考报告、环报告、
重复 ID、证书篡改检测（交换/缺帧/多帧/重复/未知/ nil）、空区间、200 组随机 DAG 交叉核对。
