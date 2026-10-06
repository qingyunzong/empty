# regexamb — 有限字母表正则 AST 歧义分析

判断一个正则表达式（并 `|`、连接、星 `*`、空串 `ε`、字面字符）是否
存在某个字符串拥有两棵不同的解析树。解析差异按 **AST 节点选择** 与
**各子节点消费区间** 定义，而不是自动机字符状态路径。

## 原理

- **AST 与稳定 id**：每个节点在构造时分配稳定整数 id，JSON 序列化
  往返保持不变（`regexamb/syntax.py`）。
- **解析树核验器**：`verify_parse` 独立检查每棵解析树的消费区间与
  AST 规则（`regexamb/parsetree.py`）。
- **判定过程（无歧义证书）**：
  1. 每个节点至多有一个空串解析（同时排除星包裹可空子表达式的
     无限空转）；
  2. 带分支标签的 Glushkov 位置自动机的同步乘积中，不存在已分叉
     且双双接受的状态对（`regexamb/automaton.py`）。
- **见证搜索**：按长度递增的有界解析树枚举给出最短、字典序最小的
  歧义串及两棵实际解析树（`regexamb/enumerate.py`）。星号层级用
  最小不动点计算，零长度循环不会发散。
- **ε 环证据**：若见证词有无限多解析（某可空子表达式的星出现在
  解析中），输出可泵送证据：基础解析 + 插入一次空重复后的泵送
  解析，两者均可被核验器验证（`regexamb/witnesses.py`）。
- **预算与恢复**：工作预算耗尽返回 `unknown` 及检查点；把检查点
  传给后续调用即可恢复（`regexamb/analyze.py`）。

## 库用法

```python
from regexamb import parse_pattern, analyze

result = analyze(parse_pattern("(a|ab)(b|ε)"), budget=1_000_000)
# {"status": "ambiguous", "word": "ab", "parses": [...], "infinite": False, ...}
```

状态为 `ambiguous`（含见证词与两棵解析树，可能附 `epsilon_loop`）、
`unambiguous`（含证书）或 `unknown`（含可恢复的检查点）。

## JSON CLI

```sh
echo '{"pattern": "(a*)*"}' | python3.11 -m regexamb --pretty
echo '{"pattern": "aaaa(a|a)", "budget": 1, "checkpoint": "ckpt.json"}' | python3.11 -m regexamb
echo '{"pattern": "aaaa(a|a)", "budget": 50000000, "resume": "ckpt.json"}' | python3.11 -m regexamb
```

请求字段：`pattern`（模式串）或 `ast`（带显式 id 的 AST JSON）、
`alphabet`、`budget`、`resume`、`checkpoint`。模式语法：字面字符、
`|`、并置、`*`、`()`、`ε` 或 `()` 表示空串、`\` 转义。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

测试包含：语法与稳定 id、解析树核验器（含证据篡改拒绝）、规定案例
（`a|a`、`(a*)*`、可空连接、同一解析归一化、空串歧义、同长见证、
无歧义长前缀）、与独立有界枚举器在长度 ≤ 6 上的对照、预算耗尽与
恢复、CLI 端到端。
