# circcov

圆周覆盖库（仅 Go 标准库）：跟踪圆周上的扇区增删，查询被至少 k 个扇区覆盖的最长圆周段及其来源集合。

## 编码规则

- **整数角单位**：圆周共 `n` 个单位，编号 `0..n-1`；传入角度一律按模 n 归一化（支持负角与超界角）。
- **闭开规则**：扇区为半开区间 `[start, end)`，覆盖单位 `start … end-1`，不覆盖 `end`。
- **跨零分裂**：归一化后 `end < start` 的扇区跨零，内部存为 `[start, n)` 与 `[0, end)` 两段。
- **全圆单独编码**：整圆用 `AddFull` / `Segment.Full` 表示，绝不用 `[x, x)`；归一化后首尾相等的扇区返回 `ErrDegenerate`。

## API

- `New(n)` 建圆；`Add(start, end) (id, error)` 增扇区；`AddFull() id` 增整圆；`Remove(id) bool` 删扇区。
- `MaxCovered(k) (seg Segment, sources []int, ok bool)`：返回每个单位都被 ≥k 个扇区覆盖的最长圆周段（等长取起始角最小者），以及完整覆盖该段的扇区 id 集合（来源集合）；无任何单位达到 k 时 `ok=false`；`k<=0` 时整圆平凡成立。

## 测试

`model_test.go` 在微小角域（1..24 单位）上用逐点模型（每个单位独立计数、扫描所有起点求最长段）与扫描线实现做随机增删对拍；`circcov_test.go` 覆盖分裂、闭开、全圆编码、删除、跨零最长段、来源集合、并列平局等单元用例。

运行：`go test ./...`
