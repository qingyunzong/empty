# upval

一个带逃逸分析与共享可变单元（cell）的闭包小语言，纯 Python 3.11+
标准库实现，无第三方依赖。

## 语言

- `let x = <expr>;` 变量定义（初始化器内可见自身名字，支持递归函数）
- `x = <expr>;` 赋值
- `fn(a, b) { ... }` 函数字面量；`return <expr>;` 返回
- `if <expr> { ... } else { ... }` 条件语句（非 0 为真）
- 整数运算：`+ - * / %`（`/` 为整除）、比较 `< <= > >= == !=`（结果为 1/0）
- 调用 `f(a, b)`；内置 `print(x)`；`#` 行注释

## 语义要点

- **逃逸分析**：解析后做作用域解析 + 逃逸分析。被逃逸内层 `fn`
  引用的局部变量装箱为共享 cell，其余保持栈槽（debug JSON 中
  `boxed: false`）。只读且不逃逸的被捕获变量**不**装箱。
- **共享 cell**：同一外层变量被多个内层函数捕获时共享同一 cell，
  赋值互相可见（见 `examples/counter.fn`）。
- **FreeVar**：引用未定义自由变量报编译错；递归函数名在自身体内可见；
  重复捕获按首次出现序去重（debug JSON 的 `captures`）。
- **DuplicateDef**：重复定义（同层或跨层遮蔽外层可见名字）报编译错。
- **退出码**：运行错 = 9，编译错 = 10；错误以 JSON 输出到 stderr，
  含 `var`、`level`、`span` 字段。

## CLI

```sh
python -m upval src.fn --run          # 编译并运行，结果以 => 输出
python -m upval src.fn                # 仅编译检查
python -m upval src.fn --debug-json   # 打印逃逸分析/捕获信息 JSON
```

示例（`examples/counter.fn`，make_counter 返回两个共享 cell 的函数）：

```console
$ python -m upval examples/counter.fn --run
1
2
2
3
3
=> 3
```

错误示例：

```console
$ python -m upval /tmp/free.fn --run        # return z + 1; （z 未定义）
{"error": "FreeVar", "var": "z", "level": 1, "span": [22, 23], "message": "undefined variable 'z'"}
$ echo $?
10
$ python -m upval /tmp/div.fn --run         # return 1 / 0;
{"error": "RuntimeError", "reason": "DivByZero", ...}
$ echo $?
9
```

## 测试

```sh
python -m unittest discover -s tests -v
```

覆盖验收项：

- **A** `TestRandomPrograms`：随机生成 300 例深度 ≤ 3 的闭包程序
  （`tests/randgen.py`，确定性种子），cell 求值器与显式环境参考解释器
  （`upval/reference.py`）的结果与打印输出完全一致。
- **B** `TestSharedCells`：make_counter 两个函数共享 cell，调用序列
  `1 2 2 3 3` 可复现，跨闭包赋值可见。
- **C** `TestEscapeAnalysis`：内层只读不逃逸变量不装箱（debug JSON
  断言 `boxed == false`）；逃逸捕获装箱；捕获按首次出现序去重。
- **D** `TestCompileErrors`：未定义自由变量（FreeVar）与跨层重复定义
  （DuplicateDef）均编译失败，错误含 `var`/`level`/`span`。

真实测试结果（本仓库当前代码，Python 3.14）：

```console
$ python -m unittest discover -s tests -v
...
Ran 29 tests in 3.656s

OK
```

## 代码结构

- `upval/lexer.py` 词法分析；`upval/parser.py` 递归下降解析（AST 带 span）
- `upval/resolver.py` 作用域解析、FreeVar/DuplicateDef 检查、逃逸分析、
  捕获计算与 debug JSON
- `upval/evaluator.py` 基于 cell/栈槽的主求值器
- `upval/reference.py` 显式环境参考解释器（用于交叉验证）
- `upval/__main__.py` CLI 入口
- `tests/test_upval.py` 全部测试；`tests/randgen.py` 随机程序生成器
