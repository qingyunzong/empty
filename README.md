# symregex — 基于 Brzozowski 导数的符号正则等价判定库

面向日志规则审计场景：判断两条正则模式是否等价、是否包含，并给出
**按（长度，字典序）最短的差异样本**；等价时产出可独立验证的**证明图**。
纯 Python 3.11 标准库实现，不依赖宿主正则引擎。

## 表达式语法

| 语法 | 含义 |
| --- | --- |
| `a` | 字面字符（必须在字母表内） |
| `.` | 字母表中任意字符 |
| `[a-z]` / `[^a-z]` | 字符区间 / 相对字母表取补的字符类 |
| `@` 或 `ε` | 空串 |
| `#` 或 `∅` | 空集 |
| `RS` | 连接 |
| `R\|S` | 并 |
| `R&S` | 交 |
| `~R` | 补（**相对显式给定的有限字母表**） |
| `R*` | Kleene 星 |
| `\c` | 转义任意符号字符 |

优先级：`~` > `*` > 连接 > `&` > `|`。`()` 分组。

## 核心设计

- **共享节点（hash-consing）**：`Context` 内同一结构只有一份节点，
  结构等价即对象同一；nullable / 导数 / 规范化文本全部按节点 id 记忆化，
  导数等价式不会无限膨胀。
- **可证明的规范化**（构造时完成，均保持语言不变）：并/交/连接的结合、
  交换、幂等与扁平化；`R|∅=R`、`R&Σ*=R`、`R·∅=∅`、`R·ε=R`、`ε*=∅*=ε`、
  `(R*)*=R*`、`~~R=R`、`R|~R=Σ*`、`R&~R=∅`、字符集节点的并/交合并。
  （注意 `~[a]` **不能**规范化为 `[^a]`——语言 `{a}` 的补还包含 ε 与长串。）
- **符号自动机**：状态为规范化正则，迁移按符号区间合并
  （`automaton.build_dfa` / `DFA.intervals`），支持划分细化最小化
  （`automaton.minimize`）。
- **等价判定**：在左右表达式的导数积空间 BFS，首个可空性强不一致的
  pair 给出最短反例；全部一致时输出双模拟证明图
  （`engine.verify_proof` 独立验证，篡改/迁移均拒绝）。
- **预算与恢复**：`budget` 限制探索的 pair 数，耗尽返回 `unknown` 与
  可 JSON 序列化的前沿；`resume_difference` 恢复继续——前沿用 SHA-256
  指纹绑定原表达式、字母表、已访问对与队列，篡改即抛 `ValueError`，
  未探索状态绝不当作拒绝。
- **规则缓存**：`RuleEngine` 的缓存条目记录依赖的 AST 子节点集合，
  规则表达式被替换时按依赖失效，杜绝旧结果污染。

## Python API

```python
from symregex import Context, parse, shortest_difference, included, resume_difference

ctx = Context("ab")                       # 显式有限字母表
a = parse(ctx, "(a|b)*abb")
b = parse(ctx, "((a|b)(a|b)*)*a(b)(b)")

res = shortest_difference(ctx, a, b)      # 或 equivalent(ctx, a, b)
res.status                                # "equivalent" / "different" / "unknown"
res.counterexample, res.side              # 最短反例及被哪侧接受
res.proof                                 # 等价证明图（可 JSON 序列化）

res = included(ctx, parse(ctx, "a*"), parse(ctx, "(a|b)*"))  # 包含判定

res = shortest_difference(ctx, a, b, budget=1)   # 预算耗尽
res.status                              # "unknown"
res = resume_difference(res.state, budget=100)   # 恢复（绑定原表达式与字母表）
```

## JSON CLI

从 stdin 读一个 JSON 请求，向 stdout 写一个 JSON 响应：

```sh
echo '{"command":"equivalent","alphabet":"ab","left":"a*","right":"(a|@)*"}' \
  | python3.11 -m symregex
```

命令：`match`、`equivalent`、`included`、`shortest_difference`、`automaton`
（区间迁移 + 最小化结果）、`resume`（传 `state` 前沿）、`verify_proof`。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

测试用独立的 Thompson 构造 / 子集构造 / 集合运算自动机
（`symregex/thompson.py`，不走导数）对小字母表短表达式做接受语言与
等价性交叉核对，并覆盖：补与空串、交集空语言、深层嵌套星、区间端点、
最短反例并列、一步预算恢复、缓存污染、篡改证明迁移、CLI 往返。

最近一次运行：**56 tests, OK**（Python 3.11.16）。
