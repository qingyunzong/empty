# lazydfa — 惰性 NFA → DFA 确定化

面向流式识别的按需确定化库：带 ε 边与整数区间迁移的 NFA，按预算增量构造
DFA，未构造部分明确标记为 `unknown`，绝不当作拒绝。仅依赖 Python 3.11 标准库。

## 设计

- **ε 闭包索引**（`lazydfa/closure.py`）：对 ε 图做 Tarjan 强连通缩点，在凝聚
  DAG 上预计算每个分量的可达状态集；任意状态集合的闭包即若干分量可达集的
  并。索引按 NFA 的 `eps_version` 惰性重建——删除 ε 边拆分 SCC 后不会残留旧闭包。
- **区间迁移**（`lazydfa/dfa.py`）：对子集内所有符号边的端点 `lo` / `hi+1`
  排序切分原子区间，逐区间求目标子集的 ε 闭包并合并相邻同目标区间；从不展开
  字符域。
- **预算**：`state_budget` / `transition_budget`。单个状态的展开是原子的，
  超出预算即停止并置 `exhausted`。匹配到达未展开状态时返回 `unknown`。
- **检查点**：保存已发现子集、待展开队列、规范状态编号与迁移（含见证），
  多次恢复继续展开与一次性运行的最终机器完全一致。恢复时校验格式版本与
  NFA 版本，不匹配即抛 `ValueError`。
- **增量失效**：NFA 记录变更日志。ε 边变更使全部闭包失效（整体重建）；
  符号边变更仅使包含变更源状态的 DFA 子集失效并重新排队。
- **见证**：每条 DFA 迁移携带产生它的原 NFA 边（`witness`），供独立核验。

## API 速览

```python
from lazydfa import NFA, LazyDFA

nfa = NFA(3, 0, accepting=[2])
nfa.add_symbol_edge(0, 1, 97, 122)   # [a-z]
nfa.add_symbol_edge(1, 2, 48, 57)    # [0-9]
nfa.add_epsilon(2, 0)

dfa = LazyDFA(nfa, state_budget=100, transition_budget=1000)
dfa.expand()
dfa.match([97, 50])                  # "accept" / "reject" / "unknown"

ckpt = dfa.save_checkpoint()         # JSON 可序列化 dict
dfa2 = LazyDFA.restore(nfa, ckpt)    # 版本不匹配抛 ValueError
dfa2.expand()

nfa.remove_edge(edge_id)             # 按依赖失效
dfa.expand()                         # 仅重展开受影响状态
```

## JSON CLI

```sh
python3.11 -m lazydfa spec.json      # 或从 stdin 读入
```

输入：`{"nfa": {...}, "state_budget": N, "transition_budget": M,
"strings": ["a1", [97, 49]], "checkpoint_in": p, "checkpoint_out": q}`。
字符串按码点解释，整数数组直接使用。输出包含状态（`known`/`unknown`）、
带见证的迁移、预算用量与每个串的匹配结果。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

覆盖：ε 环缩点、空串接受、区间相交切分、预算正好用尽、未知状态不等于
拒绝、删除环上边后语言缩小、坏端点原子拒绝、检查点多次恢复一致性、
旧检查点版本不匹配、增删边后的依赖失效，以及 30 个随机 NFA 上全部短串
与独立 ε 闭包解释器（`lazydfa/interpreter.py`）的交叉核对。
