# regex_ambiguity

有限字母表上正则表达式 AST 的歧义分析库与 JSON CLI（Python 3.11，仅标准库）。

支持的字节语法：字面量、空串 `eps`、并 `union`、连接 `cat`、星号 `star`。
每个 AST 节点携带稳定且唯一的整数 `id`。

## 解析差异的定义

两棵解析树不同，当且仅当它们在结构上不同：每个节点的 **AST 节点 id**、
**消费区间 [start, end)** 以及子树序列。自动机上不同的字符/状态路径若对应
同一棵解析树，会被归一化为同一解析，绝不误报为歧义。

## 算法

1. **带分支标签的自动机**（`automaton.py`）：Thompson 风格构造，每条转移
   携带解析动作（`enter/exit/choice/iter/lit/eps`）。路径的动作用列与解析树
   一一对应。
2. **可泵送 ε 环**（`analyzer._pump_witness`）：某单词有无限多解析，当且仅当
   某个解析包含**体可推空串的星节点**。直接计算最短（再按字典序）的此类
   单词，并给出 0 次 vs 1 次空转迭代的两棵解析树作为可泵送证据。
3. **同步乘积搜索**（`analyzer.analyze`）：在自动机与自身的同步乘积上按
   `(长度, 字典序)` 做 Dijkstra/BFS；字符转移同步、ε 转移各自进行；用
   equal/prefix/diverged 三态精确跟踪两条动作序列的差异。每侧在同一字符
   阶段内不得重复访问状态（零长度循环剪枝）；被剪掉的见证必然有无限多
   解析，已由第 2 步的泵送证据覆盖。
4. **预算与恢复**：步数预算或词长预算耗尽时返回 `unknown`，并附带可 JSON
   序列化的 `resume` 状态，可继续搜索。
5. **无歧义证书**：乘积搜索穷尽且无发散接受对时返回 `unambiguous`，
   附带探索过的乘积状态数等证书信息。

## 输出

- `ambiguous`：最短字典序见证词 `word`、两棵实际解析树 `parses`；
  若该词有无限多空转解析，则 `infinite: true` 且 `pump` 给出可泵送 ε 环
  （星节点 id 与 0/1 次迭代的证据）。
- `unambiguous`：`certificate`。
- `unknown`：`reason` 与 `resume`。

## CLI

```sh
echo '{"op":"analyze","ast":{"type":"union","children":[
  {"type":"lit","char":"a"},{"type":"lit","char":"a"}]}}' \
  | python3.11 -m regex_ambiguity
```

请求：
- `{"op":"analyze","ast":<ast>,"budget":{"max_steps":N,"max_word_len":M},"resume":<...>}`
- `{"op":"verify","ast":<ast>,"word":"...","parse":<tree>}` —— 独立核验解析树

AST JSON：`{"type":"lit","char":"a","id":1}` / `{"type":"eps"}` /
`{"type":"union","children":[...]}` / `{"type":"cat","children":[...]}` /
`{"type":"star","child":{...}}`；`id` 可省略（按先序确定性地自动分配）。

解析树 JSON：`{"node":<id>,"span":[s,e],"children":[...]}`。

## 库 API

```python
from regex_ambiguity import Builder, analyze, verify_parse, enumerate_parses
b = Builder()
root = b.union(b.lit("a"), b.lit("a"))
res = analyze(root)          # {"status": "ambiguous", "word": "a", ...}
```

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

测试内容：分析器单元测试（`a|a`、`(a*)*`、可空连接、空串歧义、同长见证
字典序、无歧义长前缀、归一化、预算耗尽与恢复）；解析树核验器（含证据
篡改拒绝）；与独立有界解析树枚举在长度 ≤ 6 的所有单词上对照；CLI 端到端。

最近一次运行结果：30 个测试全部通过（见下）。

```
Ran 30 tests in 1.3s
OK
```
