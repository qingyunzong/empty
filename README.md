# peepbc

一个小型栈机字节码的**窥孔优化器 + 验证器 + 解释器**，纯 Python 3.11+
标准库实现，无第三方依赖。

## 指令集

定长 3 字节指令（1 字节操作码 + 2 字节小端 u16 操作数）：

| 指令 | 操作数 | 语义 |
|------|--------|------|
| `CONST k` | 常量池索引 | 压入 `consts[k]` |
| `ADD` `SUB` `MUL` `DIV` `MOD` | — | 弹出 b、a，压入 `a op b`（C 风格截断除法；除零为运行期 fault `div_zero`） |
| `JMP t` | 指令索引 | 无条件跳转 |
| `JZ t` / `JNZ t` | 指令索引 | 弹出 v，v==0 / v!=0 时跳转 |
| `HALT` | — | 停机（pc 移出代码末尾等价于 HALT） |

二进制格式：`"PBC1"` magic、u16 常量计数 + i64 常量池、u32 指令计数 +
指令流，可选 `"MAP1"` 映射段（优化输出内嵌 old_pc→new_pc 映射）。

## CLI

```bash
# 优化（重写后自动验证；--verify 会重读输出文件再验证一次）
python -m peepbc in.bc -o out.bc --verify

# 反汇编
python -m peepbc in.bc --dump

# 文本汇编 -> 二进制
python -m peepbc prog.asm --asm -o prog.bc
```

退出码：`0` 成功；`2` IO/格式/用法错误；`7` 验证失败（**不写出任何文件**）。

## 优化规则（仅局部规则）

1. **常量折叠** `CONST a; CONST b; OP` → `CONST (a op b)`。
   `DIV`/`MOD` 的常数除数为 0 时**绝不折叠**，保留运行期 `div_zero` fault。
2. **恒等** `CONST 0; ADD`、`CONST 1; MUL` 删除。仅当紧邻前驱是生产者
   （CONST 或二元运算）时应用，保证栈上必有 x——否则会改变后续
   stack-underflow fault 的可观察栈内容。
3. **跳转链压缩** 目标是 `JMP` 的跳转直接改指链尾（循环链保持不变）。
4. **死代码删除** 无条件 `JMP`/`HALT` 之后、直到下一条标签（跳转目标）
   之前的指令删除。

跳转目标（标签）永远不会被删除或合并，因此跳转不会落入被重写模式的
中间。被删除的指令在映射中指向**下一可执行点**（其后无指令时指向
`len(code)`）。规则迭代至不动点。

## 重写后验证

对重写结果做验证，任一失败则退出码 7 且不写出：

- 跳转目标必须落在代码段内（指令边界）；
- `CONST` 操作数必须是合法常量池索引；
- 任意路径上的栈深必须在 `[0, 256]` 内（对控制流图做精确的 min/max
  抽象解释；净栈效应为正的循环会因上界不断增长而被捕获）。

## 输出映射

优化输出内嵌 `MAP1` 段，并在 stdout 打印 `old_pc -> new_pc` 映射。
真实运行示例：

```
$ python -m peepbc in.bc -o out.bc --verify
optimised 8 -> 3 instructions -> out.bc
mapping (old_pc -> new_pc):
  0 -> 0
  1 -> 0
  2 -> 0
  3 -> 1
  4 -> 1
  5 -> 1
  6 -> 2
  7 -> 2
verify: OK
```

栈深超限的折叠会被拒绝（真实输出）：

```
$ python -m peepbc big.bc -o big_out.bc --verify
verify: pc 256: stack depth may exceed 256
verification failed; output not written
$ echo $?
7
```

## 测试

```bash
python -m unittest discover -s tests -v
```

覆盖验收标准：

- **A**（`tests/test_random.py`）：固定种子随机 400 个小程序，优化前后在
  步数上限内最终栈/错误类别一致，并与测试内独立实现的参考解释器对照；
- **B**（`tests/test_optimize.py`）：`0/0` 常量不折叠，运行仍抛 `div_zero`；
- **C**（`tests/test_optimize.py`）：跳转目标/被删指令的映射指向下一可执行点；
- **D**（`tests/test_cli.py`）：折叠后栈深可能超 256 的重写被拒绝，退出码 7
  且不写出文件。

真实结果（当前工作区，Python 3.14）：

```
Ran 41 tests in 1.903s

OK
```

## 代码结构

- `peepbc/isa.py` — 操作码定义
- `peepbc/program.py` — 程序表示与二进制（含 MAP 段）编解码
- `peepbc/interp.py` — 参考解释器（定义可观察行为：最终栈 + 错误类别）
- `peepbc/optimize.py` — 窥孔优化与 old_pc→new_pc 映射
- `peepbc/verify.py` — 跳转边界 / 常量索引 / 任意路径栈深验证
- `peepbc/asm.py` — 文本汇编器（便于手写用例）
- `peepbc/cli.py` / `peepbc/__main__.py` — 命令行入口
