# conveyor

传送带模拟库（Go）。环形槽传送带 + 有限容量转接口的多带系统，支持故障暂停、
快照恢复与包裹守恒/唯一位置核验。

## 模型语义

- **单带**：N 个环形槽，每槽容量 1。每 tick 顺序为 **移动 → 转移 → 投件 → 取件**。
- **投件**：`Inject` 进入 FIFO 队列；投件口空时队首上带，堵塞时排队等待。
- **取件**：包裹到达其目标口（`DestBelt`/`DestSlot`）所在槽时被取出，进入输出流。
- **故障**：任一槽标记故障则全带暂停移动（投件、取件、转移仍工作）；故障只停本带，
  不影响其他带。
- **转接口**：有限容量缓冲，从源槽取目标带匹配的包裹，向目标槽投放。
  - 目标槽被占用时不转移，包裹在缓冲中待决；
  - 同一目标槽每 tick 至多接收一个包裹，竞争按包裹 ID 小者胜；
  - 同一包裹每 tick 至多转移一次（禁止同 tick 重复转移/级联）。
- **快照**：`Snapshot`/`Restore` 深拷贝带面位置、投件队列、故障标记、跨带待决缓冲
  与输出流；可 JSON 序列化。
- **核验**：`Locations` 给出每个包裹的唯一位置；`VerifyConservation` 校验包裹守恒。

## 用法

```go
b0 := conveyor.NewBelt(0, 8, 0)
b1 := conveyor.NewBelt(1, 8, 0)
sys := conveyor.NewSystem([]*conveyor.Belt{b0, b1}, []*conveyor.Interface{
    {ID: 1, FromBelt: 0, FromSlot: 3, ToBelt: 1, ToSlot: 0, Capacity: 2},
})
sys.Inject(0, conveyor.Package{ID: 1, DestBelt: 1, DestSlot: 5})
for t := 0; t < 100; t++ {
    removed := sys.Tick()
    _ = removed
}
snap := sys.Snapshot()
clone := conveyor.Restore(snap)
_ = clone
```

## 测试

```sh
go test ./...
```

测试包含：逐 tick 列表参考模型对绕回的交叉核验（随机属性测试）、堵塞排队 FIFO、
故障暂停与故障隔离、目标占用不转移、同 tick 转接口 ID 决胜、快照恢复一致性
（含跨带待决与 JSON 往返）、随机多带场景每 tick 包裹守恒与唯一位置检查。
