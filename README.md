# prattx

一个小型 Pratt（自顶向下算符优先级）表达式解析器与 CLI，仅依赖
Python 3.11+ 标准库，测试使用 `unittest`。

## 功能

- 词法：整数、标识符（`[A-Za-z_][A-Za-z0-9_]*`），每个 token 携带
  `span = (start, end)` 字符偏移。
- 运算符：`+ - * / % **`、一元 `+ - !`、比较 `== != < <= > >=`、
  逻辑 `&& ||`、赋值 `=`、条件 `?:`、调用 `f(a, b)`、下标 `a[i]`、
  显式括号 `( ... )`。
- 结合性与优先级（数值越大绑得越紧）：

  | 运算符 | lbp | 结合性 | 说明 |
  | --- | --- | --- | --- |
  | `=` | 5 | 右（rbp 4） | 最低优先级 |
  | `?:` | 10 | 右（else 分支 rbp 9） | then 分支为完整表达式 |
  | `||` | 20 | 左 | |
  | `&&` | 30 | 左 | |
  | `== != < <= > >=` | 40 | 左 | |
  | `+ -` | 50 | 左 | |
  | `* / %` | 60 | 左 | |
  | `**` | 70 | 右（rbp 69） | 高于一元 |
  | 一元 `+ - !` | — | 前缀 | 操作数按 rbp 69 解析，故 `-2**2 = -(2**2)` |
  | 调用/下标 | 90 | 后缀 | 最高 |

- 每个 AST 节点都含 `op`、`lbp`、`rbp`、`span` 四个字段；叶子节点
  `lbp = rbp = 0`，后缀节点 `rbp = 0`。
- 不做隐式括号改写：显式括号只影响解析，不在 AST 中留下节点。
- 未声明的标识符不是解析错误（解析器不做语义检查）。
- 语法错误抛出 `ParseError`，含 `got`、`expected`、`span` 属性。

## AST 结构

节点为可 JSON 序列化的 dict：

- `{"op": "int", "value": N, ...}` / `{"op": "ident", "name": s, ...}`
- 二元：`{"op": "+", "left": ..., "right": ..., "lbp": 50, "rbp": 50, "span": [s, e]}`
- 一元：`{"op": "unary-", "operand": ..., ...}`
- 条件：`{"op": "?:", "cond": ..., "then": ..., "else": ..., ...}`
- 调用：`{"op": "call", "func": ..., "args": [...], ...}`
- 下标：`{"op": "[]", "obj": ..., "index": ..., ...}`

## CLI 用法

```
python -m prattx --expr '1+2*3'     # 解析表达式，AST JSON 打到 stdout
python -m prattx --file path.expr   # 从文件读取
python -m prattx --expr '1+'        # 出错：错误 JSON 打到 stderr，退出码 3，stdout 无 AST
```

退出码：`0` 成功；`3` 解析错误；`2` 参数或文件读取错误。

## 真实运行记录

以下输出为本仓库实际运行所得（Python 3.14.4）。

```
$ python -m prattx --expr '-2**2' --compact
{"op": "unary-", "operand": {"op": "**", "left": {"op": "int", "value": 2, "lbp": 0, "rbp": 0, "span": [1, 2]}, "right": {"op": "int", "value": 2, "lbp": 0, "rbp": 0, "span": [4, 5]}, "lbp": 70, "rbp": 69, "span": [1, 5]}, "lbp": 0, "rbp": 69, "span": [0, 5]}
$ echo $?
0
```

```
$ python -m prattx --expr 'a(1,2][3]'
{
  "error": {
    "message": "parse error: expected ), got ] at 5:6",
    "got": "]",
    "expected": ")",
    "span": [
      5,
      6
    ]
  }
}
$ echo $?
3
```

## 测试

```
python -m unittest discover -s tests -v
```

测试内容：

- `tests/test_enumeration.py`（验收 A）：`tests/generator.py` 按语法
  枚举全部 token 长度 ≤ 5 的候选表达式，由独立的递归下降参考解析器
  （`tests/reference.py`，即“暴力括号优先级”结构）判定合法性，
  共 982 个合法表达式逐一比对 Pratt AST 与参考 AST 的结构
  （`op`、子树、`span` 完全一致），并校验每个节点都含
  `op/lbp/rbp/span`。
- `tests/test_precedence.py`（验收 B、C）：`-2**2 = -(2**2)`、
  `a=b=c = a=(b=c)`、`a?b:c?d:e = a?b:(c?d:e)` 等优先级/结合性边界。
- `tests/test_errors.py`（验收 D）：`a(1,2][3]`、`1+`、`a?:b` 等
  错误的 `got/expected/span` 稳定断言。
- `tests/test_cli.py`：CLI 端到端，含退出码 3 且 stdout 不产生 AST。

真实测试运行结果：

```
$ python -m unittest discover -s tests
Ran 28 tests in 2.679s

OK
```

## 代码结构

- `prattx/lexer.py` — 分词，`Token(kind, text, start, end)`。
- `prattx/parser.py` — Pratt 解析器（`nud`/`led` + 绑定力表）。
- `prattx/errors.py` — `ParseError(got, expected, span)`。
- `prattx/__main__.py` — CLI 入口。
