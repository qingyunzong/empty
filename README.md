# 维修排程 CLI

为至多 16 项维修任务选择候选半开窗口 `[start,end)`，目标为总费用最少。

## 模型

- 每项任务：若干候选半开窗口（选中即在该区间占用设备）、共享设备标识、放弃罚费、前置任务列表。
- 约束：
  - 依赖：前置任务完成（其窗口结束）后，后续任务窗口方可开始；
  - 前置被放弃时，后续任务只能放弃；
  - 共享同一设备的任务，所选半开区间不得重叠；
  - 每项任务至多选一个窗口，或放弃并计罚费。
- 目标：最小化「所选窗口费用 + 放弃罚费」总和。

## 求解

- 默认：分支定界（拓扑序 DFS + 后缀最小费用下界剪枝），保证最优。
- `-brute`：暴力枚举全部组合，供小规模数据验证最优性。
- 测试中以随机小数据对拍两种方法（`TestSolveMatchesBruteForce`）。

## 使用

```sh
go run . examples/sample.json          # 文本输出：每项安排与冲突解释
go run . -json examples/sample.json    # JSON 输出
go run . -brute examples/sample.json   # 暴力枚举求解
cat examples/sample.json | go run .    # 标准输入
```

## 测试

```sh
go test ./...
```
