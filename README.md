# inspector-cli

有向图巡检 CLI：在不超过 10 个点的有向图上，从固定起点出发，覆盖所有必巡边
（非负费用边允许重复走），回到起点，求最小费用闭 walk。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 输入格式（stdin 或文件，`#` 为注释）

```
n m s            # 点数(1..10) 边数 起点
u v w            # m 行有向边，w >= 0，边 id 从 0 开始按行编号
k                # 必巡边数量 (0..60)
r1 r2 ... rk     # 必巡边 id
```

## 输出

- `status: ok` / `status: unreachable`（不可达时逐条给出原因）
- `cost:` 最小总费用
- `edges:` 巡检边 id 序列（从起点出发并回到起点）
- `coverage:` 每条必巡边的覆盖次数

## 算法

- 主求解器：状态 (当前点, 必巡边覆盖位掩码) 上的 Dijkstra，首次弹出
  (起点, 满掩码) 即最优，回溯父指针得到边序列（`src/inspector.cpp`）。
- 参考验证：Floyd-Warshall 全源最短路 + 必巡边子集 DP，独立实现，
  随机小图上与主求解器对拍（`tests/test_inspector.cpp`）。
- 不可达判定：必巡边 (u,v) 可被闭 walk 覆盖当且仅当 起点可达 u 且 v 可达起点。
