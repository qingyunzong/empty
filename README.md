# regex_deriv

日志规则审计用的正则表达式等价性与差异分析库。基于 Brzozowski 导数
的符号自动机，纯 Python 3.11 标准库实现，不依赖宿主正则引擎。

## 功能

- **表达式**：字符区间 `[a-z]`、空串 `ε`、空集 `∅`、连接、并 `|`、
  交 `&`、补 `~`（相对于显式给定的有限字母表）、Kleene 星 `*`
  （另有语法糖 `+`、`?`、`.`、`[^...]`）。
- **规范化与共享节点**：所有节点哈希共享（hash-consing），构造器执行
  可证明保持语言的规范化（并/交的 ACI 规范化、吸收律、双重补消除、
  星的幂等等），保证导数集合有限、等价式不会无限膨胀。
- **符号自动机**：迁移按字符区间划分（`build_dfa`），并以划分细化
  算法最小化（`minimize`）。
- **判定过程**：`match`、`equivalent`、`included`、
  `shortest_difference`（按长度再字典序返回最短反例；等价时返回可
  独立验证的证明图，`verify_proof` 可校验，篡改或迁移到他式即失败）。
- **状态预算**：预算耗尽返回 `unknown` 及可 JSON 序列化的前沿
  （frontier）；前沿通过 SHA-256 绑定原表达式与字母表，恢复时校验，
  未探索状态绝不当成拒绝或证明。
- **规则缓存**：`RuleSet` 按依赖跟踪缓存派生结果，子表达式更改后仅
  使依赖它的缓存失效。
- **独立核对**：`regex_deriv.checker` 用经典 Thompson 构造 + 子集
  构造 + DFA 集合运算独立实现接受语言判定，测试中对小字母表短串做
  穷举交叉验证。

## 库用法

```python
from regex_deriv import Alphabet, parse, from_raw, equivalent, shortest_difference

ab = Alphabet.from_string("ab")
r1 = from_raw(parse("a(ba)*", ab))
r2 = from_raw(parse("(ab)*a", ab))
equivalent(r1, r2, ab)                 # {'status': 'equivalent', 'proof': ...}
shortest_difference(r1, r2, ab)        # 等价时同样返回证明
equivalent(r1, r2, ab, max_states=1)   # {'status': 'unknown', 'frontier': ...}
equivalent(r1, r2, ab, frontier=...)   # 从 frontier 恢复
```

## JSON CLI

```sh
echo '{"op":"shortest_difference","alphabet":"abc","r1":"a|c","r2":"b"}' \
  | python3.11 -m regex_deriv
```

支持的操作：`parse`、`match`、`equivalent`、`included`、
`shortest_difference`、`minimize`、`verify_proof`。请求字段见
`regex_deriv/cli.py` 文档字符串；`budget` 限制探索的状态数，返回的
`frontier` 可随同一表达式与字母表再次提交以恢复搜索。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```
