# mealy_dist — Mealy 机状态区分分析

针对确定性 Mealy 机（允许部分迁移）的黑盒状态区分库与 JSON CLI。
未定义的迁移被视为明确行为：输出保留错误输出 `__error__` 并进入
吸收的故障状态 `__fault__`。状态数上限为 10。

## 功能

- **状态对区分图**（`mealy_dist.pairs`）：反向 BFS 求每个可区分
  状态对的最短见证序列，并给出不可区分对与等价类。
- **自适应区分树合成**（`mealy_dist.solver`）：以当前状态不确定集
  为子问题做分支定界；信息论下界与状态对见证下界用于剪枝；相同
  子问题通过备忘录共享（搜索图是 DAG）。输入只有在不把两个候选
  合并到同一后继（同输出同后继）时才合法；不分裂不确定集的输入
  也参与搜索。预算或时间耗尽时返回当前树与下界但不声称最优；
  可通过 `carry=` 携带备忘录恢复搜索。不存在区分树时返回不可区
  分状态子集及闭包证据（同输出、后继仍在同类中）。
- **独立穷举核对**（`mealy_dist.brute`）：对小机器穷举预置输入
  序列与自适应策略树，交叉验证最优长度。
- **证书检查**（`mealy_dist.tree`）：逐分支重放证书树，验证每个
  叶节点只剩一个候选状态且不同初始状态的迹不同。

## CLI

```bash
python3.11 -m mealy_dist.cli pairs  machine.json
python3.11 -m mealy_dist.cli tree   machine.json [--budget N] [--time-limit S]
python3.11 -m mealy_dist.cli verify machine.json cert.json
python3.11 -m mealy_dist.cli brute  machine.json [--max-depth D]
```

机器 JSON 格式：

```json
{
  "states": ["q0", "q1"],
  "inputs": ["a", "b"],
  "outputs": ["0", "1"],
  "transitions": {"q0": {"a": ["q1", "0"]}, "q1": {"b": ["q0", "1"]}}
}
```

`tree` 的输出状态为 `optimal` / `partial`（预算耗尽，附下界）/
`impossible`（附不可区分子集与闭包证据）；`tree` 字段即为可交给
`verify` 的证书。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```
