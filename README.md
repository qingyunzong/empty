# symdfa — 符号 DFA 最小化器

面向规则服务的符号 DFA 压缩库：在**整数字符区间**上做划分精化最小化，
输出规范编号的商自动机、原状态到块的映射，以及每个未合并状态对的
最短区分词共享证明 DAG。仅依赖 Python 3.11 标准库。

## 特性

- **区间迁移，禁止逐字符展开**：字母表为 `[0, alphabet_size)`，每个状态的
  迁移是覆盖整个字母表的不相交 `(lo, hi, target)` 区间；重叠或空缺直接拒绝
  （`OverlapError` / `GapError`）。
- **先裁剪不可达状态**，再做划分精化；不可达状态在映射中记为 `null`。
- **逆迁移索引按区间事件维护**（`InverseIndex`）：精化器以工作列表方式
  对每个分裂块用事件扫描合并出每个源状态落入分裂块的精确字符集，
  全程不枚举字符。
- **规范编号**：从起点按区间下界升序 BFS，等价于按字典序最短到达词排序，
  不依赖集合迭代顺序；同构输入得到完全相同的序列化结果。
- **证明 DAG**：以块对为节点、反向 BFS 于块对积图，给出每对未合并状态的
  最短区分词，公共后缀只存一次。
- **增量更新**：批量更改终态或迁移后，先以受影响块为种子做增量拆分，
  再在商自动机上重新合并等价块；提交前验证所有块的终态一致性与迁移
  稳定性，失败则恢复旧分区与索引并抛出 `ValidationError`。
- **独立证书验证器**（`symdfa/verify.py`）：只做模拟与稳定性检查，
  不调用最小化器。
- **对照基线**（`symdfa/baseline.py`）：小机器上的逐对等价固定点，
  以及增量结果的全量重建对照。

## JSON 格式

DFA：

```json
{
  "alphabet_size": 2,
  "start": 0,
  "finals": [3],
  "transitions": {"0": [[0, 0, 1], [1, 1, 0]], "1": [[0, 1, 1]], "...": []}
}
```

更新批次：`{"finals": {"3": false}, "transitions": {"1": [[0, 0, 2], [1, 1, 1]]}}`

## CLI

```bash
python3.11 -m symdfa minimize dfa.json [-o cert.json]   # 最小化 + 证书
python3.11 -m symdfa update   dfa.json updates.json     # 增量更新后重新输出
python3.11 -m symdfa verify   dfa.json cert.json        # 独立验证证书
python3.11 -m symdfa baseline dfa.json                  # 与逐对固定点对照
```

退出码：`0` 成功；`1` 证书无效或对照不符；`2` DFA 输入非法（如区间重叠）；
`3` 增量提交验证失败（已回滚）。

## 库用法

```python
from symdfa import SymbolicDFA, IncrementalMinimizer, minimize, verify_certificate

dfa = SymbolicDFA(2, 0, {2}, {0: [(0, 0, 1), (1, 1, 0)],
                              1: [(0, 0, 2), (1, 1, 1)],
                              2: [(0, 1, 2)]})
result = minimize(dfa)
result.state_to_block        # 原状态 -> 规范块号（不可达为 None）
result.proof.word(0, 1)      # 块 0 与块 1 的最短区分词
verify_certificate(dfa, result.to_dict())

inc = IncrementalMinimizer(dfa)
inc.apply_updates(final_changes={2: False})   # 增量拆分/重新合并，失败自动回滚
```

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

覆盖：不可达终态、空语言、区间重叠拒绝、单终态修改引发的连锁拆分与
撤销后重新合并、同构输入序列化一致、随机小机器上最小化器与逐对等价
固定点对照、增量更新与全量重建对照、验证失败回滚、证书篡改拒绝、
验证器不依赖最小化器、CLI 端到端。

最近一次运行结果见 `TEST_RESULTS.txt`。
