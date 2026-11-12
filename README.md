# 偏序时间上的完成前沿与压实

嵌入式差分数据流宿主用二维逻辑时间表示外层批次和内层迭代，请实现可导入Go状态包，不能把它们压成字典序水位。时间t=(x,y)的分量均为非负uint64，t<=u当且仅当两分量分别不大于。宿主创建时给正整数输入数，各输入frontier和since均初始为{(0,0)}；每个输入维护有限反链frontier，含义是该输入以后只会再发满足某个f<=t的时间t；新frontier合法当且仅当它的每个元素都被旧frontier某元素支配，空frontier表示输入已结束且不能恢复。更新记录含键、时间和任意精度有符号权重，必须先验证它在该输入当前frontier允许范围内，按相同键和时间合并，权重和为0则删除。宿主可注册查询q，结果为所有输入中t<=q的每键权重和；只有全部输入frontier中都不存在f<=q时查询才完整，在使其完整的操作返回值中一次交付并移除登记，多个查询按注册ID字节序返回，重复存活注册ID拒绝，不能因为q字典序小就提前交付。另维护查询保留前沿since，查询q只有被某个since元素支配才允许；since只能按同样偏序前进，推进会使已登记却不再允许的查询整次拒绝推进，不默默取消。压实每个时间t为逐分量计算的meet{join(t,f):f属于since}，其中join取分量最大、meet取分量最小；新记录先按原始时间校验输入frontier，再以当前since同公式推进存储时间；压实后按键时间合并，要求对所有仍允许的q结果与原历史一致。since为空时只允许无登记查询并清空历史，之后拒绝新查询和更新。所有操作原子，规范化反链需去重并去掉被其他元素支配的元素，输出按(x,y)排序仅用于展示。提供序列化恢复、宿主调用例与小时间网格穷举测试，核对互不可比时间、空前沿、非法回退、抵消权重和压实前后查询等价，给每次查询是否完整的具体阻塞输入及前沿点。

## 实现与调用

包路径为 `example.org/dataeng/q0267`，Go 包名为 `dataeng`。核心入口：

- `NewHost(inputs int)` 创建宿主，`inputs` 必须为正。
- `Update` / `UpdateInt` 写入任意精度有符号权重。
- `AdvanceFrontier(input, points)` 推进输入前沿；空切片表示输入永久结束。
- `RegisterQuery(id, q)` 注册查询；若注册时已经完整则在本次返回值中立即交付。
- `AdvanceSince(points)` 推进并压实；若有存活查询会因此不再允许，整个推进被拒绝。
- `QueryStatus(id)` 返回查询是否完整、允许它的 since 点，以及每个阻塞输入的 `f <= q` 前沿点。
- `Snapshot` / `RestoreSnapshot` / `json.Marshal` / `json.Unmarshal` 提供串行化恢复。

```go
host, _ := dataeng.NewHost(2)
_, _ = host.UpdateInt(0, "clicks", dataeng.Time{X: 0, Y: 1}, 3)
_, _ = host.UpdateInt(1, "views", dataeng.Time{X: 0, Y: 2}, 7)

_, _ = host.RegisterQuery("batch-1", dataeng.Time{X: 1, Y: 1})

// (1,1) 与 (0,0) 不可比，不能用字典序代替分量偏序。
_, _ = host.AdvanceFrontier(0, []dataeng.Time{{X: 2, Y: 0}, {X: 0, Y: 2}})
_, _ = host.AdvanceFrontier(1, []dataeng.Time{{X: 2, Y: 0}, {X: 0, Y: 2}})
// 第二次 AdvanceFrontier 的 Outcome.Delivered 中按 ID 字节序包含 "batch-1"。
```

运行验证：

```sh
go test ./...
go test -race ./...
```

测试覆盖二维不可比时间、反链规范化、空前沿终结、前沿/since 非法回退、权重抵消、查询交付顺序、since 原子拒绝、串行化往返，以及在 `0..3` 小网格上对多组 since 和全部允许查询的压实前后等价性。
