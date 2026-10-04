# 实际测试结果

环境：g++ 15.2.0 (Ubuntu)，CMake 4.2.3，`-DCMAKE_BUILD_TYPE=Release`，
C++20（`-Wall -Wextra`，无警告）。

## CTest 汇总（`ctest --output-on-failure`）

```
1/5 Test #1: rational .........................   Passed    0.00 sec
2/5 Test #2: intersection .....................   Passed    0.00 sec
3/5 Test #3: incremental ......................   Passed    0.03 sec
4/5 Test #4: certificate ......................   Passed    0.02 sec
5/5 Test #5: enumeration ......................   Passed    0.21 sec
100% tests passed, 0 tests failed out of 5
```

## 各测试检查数

| 测试 | 检查数 | 失败 |
|---|---|---|
| rational | 23 | 0 |
| intersection | 29 | 0 |
| incremental | 404 | 0 |
| certificate | 111 | 0 |
| enumeration | 5 | 0 |

## 小坐标枚举验收（test_enumeration 实际输出）

网格 `{-2,-1,0,1,2}²`（25 个点）上的全部 325 条无向线段（含 25 条退化
线段），共 52,650 个边对，与独立参考实现（行列式求交 + 端点包含法提取
重叠）逐对精确比对，并验证操作数交换对称性：

```
enumeration: 325 segments, 52650 pairs: none=34384 point=17834 overlap=432,
1761 distinct points, max denominator=25
library: 325 edges, 1761 intersection points, 432 overlaps, certificates: OK
```

- 点交 17,834 次，去重后 1,761 个不同有理交点，最大分母 25（精确表示）。
- 共线重叠 432 段，全部通过极大性与共线性证书检查。
- 全部 325 条边按随机批次（每批 ≤37 条）增量入库，聚合结果与参考实现
  推导的期望映射逐键相等；`recomputeAll()` 全量重建结果与增量结果一致。
- 严格模式证书（来源边集合恰好完备）对全部 1,761 个交点与 432 段重叠
  通过。

## 增量 == 全量（test_incremental）

200 组随机试验（坐标 ∈ [-6,6]，边数 0–40，随机批划分 1–5 条/批，含退化
边）：增量结果与单批全量、`recomputeAll()` 重建三方一致（404 项检查全部
通过）。
