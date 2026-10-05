# signal — 信号周期精确优化 CLI

只使用 Go 标准库。给定固定周期（至多 60 个整数时槽）、各相位的最短放行
时间与等待费用表、以及冲突相位集合，选择整数相位长度并排出完整周期，
使总等待费用最小。

## 模型

- 一个周期由 C 个整数时槽组成，1 <= C <= 60。
- 每个时槽可以同时放行任意一个**无冲突**的相位集合（冲突相位禁止同时放行）。
- 相位 i 每周期的绿灯时槽数 g_i 必须满足 g_i >= min[i]。
- 总费用为 sum_i cost_i[g_i]，cost_i 为输入给出的等待费用表（g = 0..C）。
- 目标：最小化总费用。未使用的时槽视为全红。

## 输入格式（JSON）

```json
{
  "cycle": 12,
  "phases": [
    {"name": "A", "min": 3, "cost": [48, 44, 40, 36, 32, 28, 24, 20, 16, 12, 8, 4, 0]}
  ],
  "conflicts": [[0, 1], [1, 2]]
}
```

cost 必须恰好含 cycle+1 项；conflicts 为相位下标对。完整示例见
examples/intersection.json。

## 用法

```
go build -o signal ./cmd/signal

./signal solve      -f examples/intersection.json -o cert.json
./signal verify     -f examples/intersection.json -c cert.json
./signal exhaustive -f examples/intersection.json
```

- solve：精确动态规划求解器，输出**完整周期证书**（JSON）：逐时槽的放行
  集合 slots、各相位绿灯数 green、总费用 cost。
- verify：独立校验证书（时槽数、冲突、最短时间、费用一致性）；当周期
  足够小时自动做**穷举核对**并在输出中给出 "optimal": true。
- exhaustive：对极小周期枚举全部放行集合多重集，作为最优性对照
  （默认枚举上限 500 万，可用 -max-enum 调整）。

## 算法

- Solve：在绿灯向量空间上做 BFS。第 t 层保存恰好用 t 个时槽可实现
  的所有绿灯向量，因此首次到达某向量时的层数就是其所需的最少时槽数；
  在所有满足最短时间且层数 <= C 的向量中取费用最小者。状态数上限由
  -max-states 控制（默认 4,000,000）。
- Exhaustive：枚举全部“至多 C 个非空独立集”的多重集（共 C(C+k, k)
  个，k 为独立集个数），逐一计算费用取最小，用于极小周期的最优性核对。

## 限制

- 相位数 <= 10（绿灯向量按每相位 6 bit 打包进 64 位整数）。
- 周期 <= 60。
- 不可行（最短时间之和在冲突约束下排不进周期）时以非零码退出并报告
  infeasible。

## 测试

```
go test ./...
```

覆盖：手算用例（冲突/无冲突/全冲突三角形）、300 组随机小实例上 DP 与
穷举对拍、证书校验的正反用例、输入校验、CLI 端到端（solve/verify/
exhaustive/篡改证书/周期超限/不可行）。

实际运行结果（Go 1.27.1, linux/amd64, go test ./... -count=1）：

```
ok  	signalcli/cmd/signal	0.020s
ok  	signalcli/internal/signal	0.153s
```
