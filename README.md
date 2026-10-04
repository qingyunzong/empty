# locate — 多传感器范围定位库

每个传感器给出一个坐标矩形范围与置信权，库计算：

- **可行区域**：被至少 `k` 个传感器范围覆盖的区域（`FeasibleRegion`），
  输出为规范化矩形列表及各自来源传感器；
- **最小冲突子集**：当可行区域为空时，给出需剔除的总置信权最小的
  传感器子集（`MinConflictSubset`），剔除后剩余传感器恢复一致。

仅使用 Go 标准库。传感器数量上限 `MaxSensors = 18`（冲突子集按子集枚举，规模 2^18）。

## API

| 函数 | 说明 |
|---|---|
| `R(minX, minY, maxX, maxY) Rect` | 构造规范化矩形（自动交换颠倒坐标） |
| `CoverCount(sensors, x, y) int` | 覆盖某点的传感器数量 |
| `Feasible(sensors, k) bool` | k-覆盖可行区域是否非空 |
| `FeasibleRegion(sensors, k) []Region` | 可行区域的规范分解（矩形 + 来源） |
| `MaxConsistentSubset(sensors) []Sensor` | 公共交非空且总置信权最大的子集 |
| `MinConflictSubset(sensors, k) ([]Sensor, bool)` | 可行区域为空时的最小冲突子集 |

## 设计说明

- **规范矩形**：对所有矩形边界做坐标压缩得到单元格网格，每个单元格记录
  覆盖它的传感器位掩码；按行取掩码相同的极大水平段、再纵向合并列区间与
  掩码均相同的相邻段，得到互不重叠的规范分解。每个输出矩形内部覆盖集合
  恒定，`Sources` 即为该集合（升序、数量 ≥ k），输出按坐标字典序排序，
  结果确定。退化（零面积）矩形不产生可行区域，计算时忽略。
- **最小冲突子集**：k-覆盖关于剔除是单调的（剔除传感器不会增加覆盖数），
  因此"剔除后恢复 k-覆盖"不可行；库采用的恢复目标是**剩余传感器存在非空
  公共交**（即被剔除者是导致不一致的冲突源）。实现为枚举所有子集求
  最大总置信权的一致子集（`MaxConsistentSubset`），其补集即最小冲突子集；
  平局时数量更多、ID 字典序更小者优先，保证确定性。

## 测试

- `cover_test.go`：固定用例（基本相交、十字形分解与来源、k=1 并集）+
  **小网格穷举核对**（200 组随机用例，0.25 步长网格逐点比较
  "在可行区域内"与"覆盖数 ≥ k"，并核对区域总面积与网格面积一致）+
  确定性检查。
- `conflict_test.go`：固定用例（含"最小权需剔除多个"的权/数权衡）+
  **子集检查核对**（150 组随机用例，穷举全部 2^n 剔除子集，验证返回的
  冲突子集确实使剩余恢复一致且总置信权等于穷举最小值）+
  18 传感器上限冒烟测试。

## 实际运行结果

环境：go1.27.1 linux/amd64。命令：`go test ./... -v -count=1`

```
=== RUN   TestMinConflictSubsetBasic
--- PASS: TestMinConflictSubsetBasic (0.00s)
=== RUN   TestMinConflictSubsetWeightOverCount
--- PASS: TestMinConflictSubsetWeightOverCount (0.00s)
=== RUN   TestMinConflictSubsetFeasibleReturnsFalse
--- PASS: TestMinConflictSubsetFeasibleReturnsFalse (0.00s)
=== RUN   TestMaxConsistentSubset
--- PASS: TestMaxConsistentSubset (0.00s)
=== RUN   TestMinConflictSubsetVerifyByEnumeration
--- PASS: TestMinConflictSubsetVerifyByEnumeration (0.00s)
=== RUN   TestMinConflictSubsetMaxSensors
--- PASS: TestMinConflictSubsetMaxSensors (0.04s)
=== RUN   TestNormalizeRect
--- PASS: TestNormalizeRect (0.00s)
=== RUN   TestFeasibleRegionBasic
--- PASS: TestFeasibleRegionBasic (0.00s)
=== RUN   TestFeasibleRegionSourcesAndShape
--- PASS: TestFeasibleRegionSourcesAndShape (0.00s)
=== RUN   TestFeasibleRegionK1Union
--- PASS: TestFeasibleRegionK1Union (0.00s)
=== RUN   TestFeasibleRegionGridBruteForce
--- PASS: TestFeasibleRegionGridBruteForce (0.01s)
=== RUN   TestFeasibleRegionDeterministic
--- PASS: TestFeasibleRegionDeterministic (0.00s)
PASS
ok  	locate	0.054s
```

`go vet ./...` 与 `gofmt -l .`（无输出）均通过。
