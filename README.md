# locate — 多传感器矩形范围定位库

纯 Go 标准库实现，无第三方依赖。

## 问题语义

- 每个传感器给出目标可能所在的**坐标矩形范围**（轴对齐、闭区间）与**置信权**。
- **可行区域**：平面中被**至少 k 个**范围覆盖的点集。
- 若可行区域为空，给出**最小冲突子集**：传感器数量最少、且矩形公共交集为空的子集，
  作为不可行的最小证书（对轴对齐矩形，由 Helly 定理它必为一对不相交矩形，蛮力枚举可核对）。
- 传感器数量上限 **18**（冲突子集需 2^18 枚举）。

## 输出规范

`CoveredRegion(sensors, k) []RegionRect`：

- 算法：取所有矩形边为分割线切出基本单元（单元内覆盖集合恒定），
  保留覆盖数 ≥ k 的单元，先按行合并同来源签名的相邻单元为水平条带，
  再纵向合并 x 范围与签名相同的相邻条带。
- 每块 `RegionRect` 为**规范矩形**（`MinX<=MaxX, MinY<=MaxY`，非退化），附带：
  - `Sources`：完整覆盖该矩形的来源传感器 ID（字典序）；
  - `Weight`：来源传感器置信权之和。
- 输出按 `(MinX, MinY, MaxX, MaxY)` 排序，结果确定。

`MinConflictSubset(sensors) ([]Sensor, error)`：

- 全体交集非空时返回 `nil`（无冲突）；超过 18 个传感器返回 `ErrTooManySensors`。
- 否则按子集尺寸从小到大枚举，返回尺寸最小且公共交集为空的子集；
  同尺寸取置信权之和最大者，再相同按 ID 字典序，保证确定性。

## 核对方式（测试）

- **小网格穷举**（`TestGridExhaustive`）：以 0.025 步长采样网格点，逐点统计覆盖数，
  与输出区域成员资格逐点比对，并比较网格面积与区域总面积。
- **子集检查**（`assertMinimality`）：蛮力枚举所有更小子集，
  核对返回的冲突子集交集为空且不存在更小的冲突子集。
- 另含手算基准用例、权重平局裁决、18 上限等测试。

## 实测结果

```
$ go test ./...
ok  	locate	0.006s
```

8 个测试全部通过（Go 1.27.1, linux/amd64）：

```
=== RUN   TestCanonical                        --- PASS
=== RUN   TestCoveredRegionBasic               --- PASS
=== RUN   TestGridExhaustive                   --- PASS
=== RUN   TestConflictSubset                   --- PASS
=== RUN   TestConflictSubsetWeightTieBreak     --- PASS
=== RUN   TestConflictSubsetLarger             --- PASS
=== RUN   TestNoConflict                       --- PASS
=== RUN   TestTooManySensors                   --- PASS
```
