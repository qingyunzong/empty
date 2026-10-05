# circsim

同步轮次更新的四值电路模拟库，仅使用 Go 标准库。

## 值系统

`Value` 取 `Zero`、`One`、`X`（未知）、`Z`（高阻）。多驱动网络用
`Resolve` 汇合：`Z` 是单位元，相同值一致，`0`/`1` 冲突或含 `X`
均为 `X`。外部输入独占驱动其网络（忽略该网络上的门输出）。

## 门与公开门表

`Buf`、`Not`、`And`、`Or`、`Xor`、`Nand`、`Nor`、`Xnor` 八种门，语义
完全由公开真值表定义（`NotTable`、`AndTable` 等，`[4]` 或
`[4][4]Value`，以 `Value` 常量作下标），`GateKind.Eval` 直接查表。

## 同步迭代与终止判定

每轮所有门基于轮初状态求值，网络值在轮边界同步更新。终止条件：

- **收敛（Converged）**：下一轮状态与当前相同，`Values` 为稳定值；
- **循环（Cyclic）**：下一轮状态曾在历史中出现，`Period` 为周期，
  `Witness` 为一个完整周期的状态序列；
- **预算耗尽（Exhausted）**：轮数达到 budget 仍未判定。

## 两种引擎与核对

- `IterateFull`：参考实现，每轮完整重估所有门；
- `Simulator`：增量实现，缓存门输出，仅重估输入发生变化的门
  （dirty 跟踪），支持 `SetInput` 在输入变化后从当前状态续跑。

`TestIncrementalMatchesFull` 用随机电路与随机输入变化序列，逐次核对
增量续跑与从同一状态出发的完整状态迭代，结果（状态、轮数、周期、
见证）完全一致。

## 测试

```sh
go test ./...
```
