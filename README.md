# circlecover

圆周扇区覆盖库（仅 Go 标准库）。维护圆周上的一组扇区，支持增删，并查询
"至少被 k 个扇区覆盖的最长圆周段"及其来源集合。

## 角度模型

- 圆周离散为 `mod` 个整数单位，编号 `0..mod-1`，逆时针排列；单位 `p` 即切片 `[p, p+1)`。
- 扇区为半开弧 `[start, end)`（闭开规则）：**含 start，不含 end**。
- `end < start` 时弧跨越零角，内部自动分裂为 `[start, mod)` 与 `[0, end)` 两段。
- `start == end` 视为退化并拒绝（`ErrDegenerate`）；**全圆单独编码**，由 `AddFull` 加入，
  绝不由零长弧表示。

## API

- `New(mod)` / `Add(start, end)` / `AddFull()` / `Remove(id)` / `CoverageAt(p)`
- `MaxSegment(k) (Segment, bool)`：返回每个单位覆盖数均 ≥ k 的最长弧。
  - 跨零相邻的合格段会合并，结果可能回绕（`End < Start`）。
  - 全圆合格时返回 `Full: true, Length: mod`。
  - 等长时取 `Start` 最小者；无任何单位达到 k（或 k < 1）时第二返回值为 false。
  - `Segment.Sources` 为覆盖该段至少一个单位的扇区 ID 集合（升序），段内每个单位
    至少有 k 个来源重叠。

## 测试

`circlecover_test.go` 包含确定性规则测试（闭开边界、跨零分裂、全圆编码、增删、
并列取址）以及随机化交叉核对：在 2..16 单位的微小角域上随机增删扇区，每次操作后
用逐点暴力模型核对全部单位的覆盖数、`MaxSegment` 的长度/起点/全圆标志与来源集合。

实际运行结果（go1.27.1 linux/amd64，`GOCACHE=/tmp/gocache go test ./...`）：

```
ok  	circlecover	0.498s
```

全部 9 个测试通过（含 300 组随机用例的逐点模型核对）。
