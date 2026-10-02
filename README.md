# interlock-sim

包装产线联锁控制仿真器：控制 DSL → 静态检查 → 字节码状态机 → 按 tick 运行的 VM。
Node.js 22，仅使用标准库，全程单机离线，无第三方依赖。

## 快速开始

```sh
node src/cli.js run examples/machine.dsl examples/commands.jsonl --trace out.json
node --test
```

## 架构

```
src/lexer.js     词法层：信号名（标识符）、布尔 true/false、毫秒字面量 500ms、枚举字面量
src/parser.js    Pratt 解析器：守卫表达式 not/and/or 与比较运算，优先级 not > 比较 > and > or
src/checker.js   静态类型：input / output / timer 三类信号；设备块内名称沿作用域链解析（词法作用域，可遮蔽全局）
src/compiler.js  编译为字节码（CONST/LOAD/NOT/AND/OR/EQ/NE/LT/LE/GT/GE）
src/vm.js        每 tick：先读输入 → 求守卫（设备规则按声明顺序单趟执行）→ 原子提交输出
src/cli.js       命令行入口
```

## DSL 参考

```dsl
enum ValveState { closed, open }

signal door_closed : input bool = false      # 输入信号
signal motor : output bool = false           # 输出信号
signal fill_timer : timer ms = 0ms           # 定时器（只能为 ms 类型）

invariant not (motor and not door_closed)    # 安全不变量（必须为 bool）

device filler {                              # 设备块：内部名称有词法作用域
  signal jammed : input bool = false         # 设备局部信号，命令中用 filler.jammed 引用
  rule stop_motor_on_jam when jammed and motor set motor = false
  rule open_valve when fill_timer >= 500ms set fill_valve = open
}
```

- 类型系统：`bool`、`ms`、枚举；`timer` 信号必须为 `ms`，`input`/`output` 不能为 `ms`。
- 比较：`==`/`!=` 用于同类型值；`<`/`<=`/`>`/`>=` 仅用于 `ms`。
- 同一作用域内重复信号、重复枚举、类型不匹配、未定义名称均为编译错误，
  以 `文件:行:列: error: 消息` 格式输出，且一次报告全部错误。

## 命令文件（JSONL）

每行一个 JSON 对象，`tick` 为逻辑时间戳；同一 timestamp 的多条命令严格按输入顺序应用：

```json
{"tick":0,"cmd":"set_input","signal":"door_closed","value":true}
{"tick":1,"cmd":"set_output","signal":"motor","value":true}
{"tick":2,"cmd":"start_timer","signal":"fill_timer","ms":0}
{"tick":3,"cmd":"advance","ms":600}
{"tick":4,"cmd":"undo"}
{"tick":5,"cmd":"redo"}
```

语义：

- 每条命令触发一个 tick 周期：应用命令效果 → 校验不变量 → 求守卫执行规则 → 再次校验 → 原子提交。
- 安全不变量被违反时命令被拒绝，状态完全不变（拒绝的命令不进历史）。
- 命令历史只记录被接受的命令；`undo` 恢复到上一已提交状态；
  `redo` 仅在 undo 之后没有发生新命令时可用（新命令会截断 redo 尾部）。
- 运行时类型错误（对 output 用 set_input、布尔信号赋字符串等）同样被拒绝且状态不变。

## CLI

```
node src/cli.js run <machine.dsl> <commands.jsonl> [--trace <out.json>]
```

trace 为 JSON：每条命令一项，含 `tick`、`accepted`、`reason`（接受/拒绝原因）与提交后的每信号状态快照；
省略 `--trace` 时输出到 stdout。

退出码（实测）：

| 退出码 | 含义 |
|--------|------|
| 0 | 仿真完成，trace 已写出 |
| 1 | 用法错误或文件不可读 |
| 2 | DSL 词法/语法/类型错误（带行:列） |
| 3 | commands.jsonl 存在非法 JSON 行（带行号） |

## 测试

```sh
node --test
```

实测结果（Node v22.22.1）：**41 个测试全部通过，0 失败，退出码 0**
（`node --test` 汇总输出：`tests 6, pass 6, fail 0` —— 按文件计 6 项，
其中 5 个测试文件共 41 个用例，外加 1 个无断言的 helpers 模块）。

覆盖验收项：

1. `test/vm.test.js` 正常启动顺序（关门 → 上料 → 启电机 → 定时器到点开阀 → 卡料联锁停机）
2. `test/vm.test.js` 门未关启动电机被拒，状态不变，undo 无可撤销、状态不变
3. `test/vm.test.js` 接受命令后 undo/redo 恢复；新命令后 redo 不可用
4. `test/vm.test.js` 同一 tick 两条命令按输入顺序产生不同结果（顺序边界）
5. `test/property.test.js` 300 个种子 × ≤12 步随机命令序列，字节码 VM 与独立 AST 解释参考模型逐步一致
6. `test/checker.test.js` 类型错误（not 作用于 ms、跨类型比较、规则写 input、枚举字面值越界等）与重复信号/枚举错误，均带行列
