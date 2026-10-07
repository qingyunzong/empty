# ammo_sim — 整数弹药分配优化仿真工具

向 ≤10 个目标分配 ≤4 类整数弹药，总弹药预算 ≤20。每个目标的损伤由输入的
**离散损伤表**决定（不做任何线性/单调性假设）。优化目标按字典序：

1. 最大化达标（损伤 ≥ 阈值）目标的总价值；
2. 价值相同时，最小化总弹药消耗。

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## 输入格式（stdin，空白分隔）

```
T K B                 # 目标数(<=10) 弹药类数(<=4) 总预算(<=20)
threshold_1 .. thr_T  # 每目标达标阈值
value_1 .. value_T    # 每目标价值
E                     # 损伤表条目数
t a_1 .. a_K damage   # 共 E 行：目标 弹药向量 损伤（缺省为 0）
```

## 运行

```sh
./build/ammo_sim < examples/sample.txt          # DP 求解，输出评估表
./build/ammo_sim --reference < examples/sample.txt   # 全向量枚举参考
./build/ammo_sim --check < examples/sample.txt       # 两者对比核验
```

输出为逐目标评估表：弹药向量、弹药花费、损伤、阈值、是否达标、获得价值，
以及总计行（总价值 / 总弹药）。

## 方法

- **主求解器 `solveDP`**：先对每个目标枚举全部 C(B+K, K) 个弹药向量，把离散
  损伤表归约为"每花费 c 的最大损伤及对应向量"；再做 (目标 × 预算) 二维 DP，
  按 (价值降序, 弹药升序) 字典序转移并回溯出每目标的弹药向量。
- **参考实现 `solveReference`**：不做任何归约，对每个目标枚举全部弹药向量并
  DFS 组合所有目标，直接取字典序最优。仅用于核验，复杂度随规模指数增长。
- **CTest**：7 个手工场景（含非线性协同、弹药平局决胜、预算约束、不可达
  阈值、零预算、4 类弹药）+ 2 组随机化交叉核验（DP vs 全枚举，固定种子）。
