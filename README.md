# raster

整数有向闭环栅格化库（仅 Go 标准库）。

## 模型

- 输入：`Loop`（整数顶点有向闭环，末点自动连回首点）；洞用额外线环表示，
  `Polygon{Shell, Holes}` 只是便捷包装。
- 像素 `(x, y)` 为单位方格 `[x,x+1)×[y,y+1)`，采样点为像素中心 `(x+0.5, y+0.5)`。
- 填充规则：`NonZero`（非零绕数）与 `EvenOdd`（奇偶）。`NonZero` 下洞环须与
  外环反向；`EvenOdd` 与方向无关。
- 输出：`[]Span`，逐行水平区间 `{Y, X0, X1}`（含端点），按行、按 X0 排序，
  相邻连续段已合并。

## 边的特殊规则

- **水平边**永不产生交点，直接跳过；跨越水平边的填充状态由非水平边决定。
- **半开区间**：非水平边拥有 `[min(y0,y1), max(y0,y1))`，含下端点、不含上端点。
  两条边共享的顶点恰好被计一次（由以其为下端点的边计入），绝不重复；
  局部极值点被计 0 或 2 次，保持奇偶性。
- **边界上的像素中心**：射线起点处的交点不计入（严格大于比较），
  恰好落在边上的像素中心按"不计该交点"判定。

## 精确性

所有判定用精确整数运算：坐标放大 2 倍后像素中心为奇整数，交点横坐标以有理数
`num/den` 表示，排序比较使用 128 位乘积（`math/bits`），无浮点误差。
顶点坐标须满足 `|v| <= 1<<30`。

## API

- `Fill(loops []Loop, rule FillRule) []Span` — 扫描线填充，输出行区间。
- `Contains(loops []Loop, rule FillRule, px, py int) bool` — 逐像素精确射线
  模型，作为 `Fill` 的参照实现。

## 验证

`raster_test.go` 用逐像素精确射线模型（`Contains`）核对 `Fill` 的输出：
对外接框（含 2 像素余量）内每个像素逐一比对，覆盖方形、三角形、凹多边形、
五角星、带洞多边形、同向嵌套、自交领结、共边方块、负坐标、退化环
（空环/单点/重复顶点/零长边/共线边/尖刺）、边界穿越像素中心等用例，
外加 300 组随机环（含随机洞）× 两种规则的模糊测试。

实际运行结果（Go 1.27.1，linux/amd64，2026-10-05T13:55:03Z）：

```
$ go test ./... -count=1
ok  	raster	0.208s
```

逐项：`TestSquareSpans`、`TestHoleSpans`、`TestHoleOrientationNonZero`、
`TestBoundaryConvention`、`TestDegenerateLoops`、`TestShapesAgainstRayModel`、
`TestFuzzRayModel` 全部 PASS。
