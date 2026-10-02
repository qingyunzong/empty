# obs-correction

观测流更正库及 CLI。输入为 JSON 记录数组与更正脚本，脚本经词法分析、编译为字节码后，
由按批处理的 VM 执行；每批开始写 checkpoint，失败时整批回滚，支持崩溃后从状态文件断点续跑。
仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 脚本格式

词法器区分三类行：

- `#!correction <name>`：指令块，后续行按语句词法分析；
- `#!table <name>`：CSV 数据块，后续行按普通 CSV 行词法分析（供 `map` 查表）；
- 引用字符串：`"..."` / `'...'` 整体作为一个 token，串内逗号、转义不影响切分。

`#` 开头为注释。语句一览：

```
set <field> <number|string>        # 赋值
add|sub|mul|div <field> <a> <b>    # 算术，a/b 为数字字面量或字段名
clamp <field> <lo> <hi>            # 越界收敛到 [lo, hi]，不视为失败
filter <field> <cmp> <value>       # 条件不满足则丢弃该记录（不算失败）
if <field> <cmp> <value> goto <L>  # 条件跳转
goto <L> / jmp <L>                 # 无条件跳转
label <L>                          # 跳转目标
map <field> = <table>[<keyField>]  # 查表更正
# cmp: == != > >= < <=
```

## 字节码与 VM

编译产物为 `SET / ADD / SUB / MUL / DIV / CLAMP / FILTER / CMP / JIF / JMP / MAP / HALT`
指令序列。VM 对每条记录从 pc=0 顺序执行；`FILTER` 不满足返回丢弃标记。

失败语义（触发整批回滚到 checkpoint，已发出的更正全部撤销）：

- `MissingField`：引用了记录中不存在的字段；
- `DivByZero`：除数为零；
- `LookupMiss`：`map` 查表未命中；
- `TypeMismatch`：算术/clamp 操作数非数值。

越界 clamp **不是**失败，值被收敛到区间内。

## 批处理、checkpoint 与崩溃恢复

- 每批开始写 checkpoint（`phase: "checkpoint"`），记录已成功处理的序号；
  批内全部成功后写 commit（`phase: "committed"`），状态含 `committed / results / batches`。
- 状态文件通过临时文件 + rename 原子写入，崩溃不会留下半写文件。
- `--crash N`：执行完第 N 条字节码后、下一 checkpoint 前模拟崩溃（退出码 2）。
- 带 `--state` 重跑时从 `committed` 边界之后继续，已提交记录不会二次生效。

## CLI

```
node src/cli.js --input records.json --script correction.txt [options]
  --batch-size N   每批记录数（默认 10）
  --crash N        在第 N 条字节码后模拟崩溃
  --state PATH     checkpoint/commit 状态文件，用于断点续跑
  --output PATH    报告写入文件（默认 stdout）
```

退出码：`0` 成功；`1` 处理失败（整批回滚，输出错误与已提交边界）；
`2` 模拟崩溃；`3` 参数/IO 错误。

成功输出 `{ ok, records, batches }`；失败输出
`{ ok, error, committedBoundary, records, batches }`。

## 示例

```
node src/cli.js --input examples/records.json --script examples/correction.txt --batch-size 2
```

## 测试

```
node --test
```

实测结果（Node v22.22.1）：5 个测试文件全部通过，覆盖：

1. 5 条记录正常执行，输出与手算结果一致（`test/acceptance.test.js`）；
2. 第 4 条记录除零 → 整批回滚，仅保留前一已提交批（committedBoundary = 3）；
3. `--crash 20` 崩溃后带状态文件重跑，序号与结果与无故障一次运行完全一致，
   且重复执行不会二次生效。
