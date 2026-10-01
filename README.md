# upval

一个带词法闭包与 upvalue 捕获的玩具语言（Python 3.11+，仅标准库）。
流水线：解析 → 作用域解析 + 逃逸分析 → 解释执行。

## 语言

- `let x = <expr>;` 绑定；`x = <expr>;` 赋值
- `fn(a, b) { ... }` 函数字面量；`f(1, 2)` 调用
- 整数运算：`+ - * / %`（`/`、`%` 为截断语义）与比较 `< <= == != > >=`（结果为 1/0）
- `if <expr> { ... } else { ... }` 条件表达式
- 块内最后一条表达式语句的值即块的值；程序的值是最后一条语句的值
- 注释：`# ...` 或 `// ...`

## 语义要点

1. 解析后做逃逸分析：被内层 `fn` 引用、且外层返回后仍可达的局部变量
   **装箱为 cell**（逃逸提升），否则留在栈槽。
2. 同一外层变量被多个内层函数捕获时**共享同一个 cell**，赋值互相可见。
3. 未定义的自由变量报 `FreeVar`；递归函数名在自身体内可见
   （`let f = fn(...) { ... f(...) ... }`）；重复捕获按首次出现序去重。
4. 不允许重复定义（包括跨层遮蔽）：报 `DuplicateDef`。
5. 只被不逃逸的内层函数读取的变量**不装箱**，闭包直接引用外层帧槽。

## CLI

```sh
python -m upval src.fn --run      # 编译并运行，打印结果
python -m upval src.fn --debug    # 打印逃逸分析 debug JSON（locals/boxed/upvalues）
python -m upval src.fn            # 仅编译检查
```

退出码：`0` 正常；`9` 运行错；`10` 编译错。错误以 JSON 输出到 stderr，
含 `var`、`level`、`span` 字段，例如：

```json
{"error": "FreeVar", "message": "undefined free variable 'missing'", "var": "missing", "level": 2, "span": {"start_line": 2, "start_col": 20, "end_line": 2, "end_col": 27}}
```

示例（`make_counter`，`inc`/`get` 共享 `count` 的 cell）：

```sh
$ python -m upval counter.fn --run
3
```

## 测试

```sh
python -m unittest discover -s tests -v
```

真实运行结果（Python 3.14.4）：

```
Ran 18 tests in 4.094s

OK
```

覆盖验收点：

- **A** `TestRandomClosures`：随机生成 300 例深度 ≤ 3 的闭包程序，
  与显式环境参考解释器（`upval/refinterp.py`）结果逐一比对一致。
- **B** `TestMakeCounter`：`make_counter` 返回两个共享 cell 的函数，
  调用序列 `inc();inc();inc();get()` 结果可复现为 `3`（CLI 连跑两次输出相同）。
- **C** `TestEscapeAnalysis`：内层只读且不逃逸的变量 `boxed: false`
  （通过 `--debug` JSON 断言）；逃逸/传递性逃逸场景 `boxed: true`；
  捕获按首次出现序去重。
- **D** `TestErrors`：未定义自由变量报 `FreeVar`（含 `var/level/span`），
  同层与跨层重复定义报 `DuplicateDef`；CLI 运行错退出码 9、编译错退出码 10。

## 代码结构

- `upval/lexer.py` / `upval/parser.py`：词法、递归下降解析（带 span）
- `upval/resolver.py`：作用域解析（upvalue 穿线、去重）、逃逸分析、debug JSON
- `upval/interp.py`：主解释器（cell / 栈槽 / 帧引用）
- `upval/refinterp.py`：显式环境参考解释器（差分测试基准）
- `upval/__main__.py`：CLI 入口
