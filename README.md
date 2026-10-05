# debuglib — 解释器条件断点调试库

一个纯 Go 标准库实现的玩具解释器（`interp`）及其调试库（`debugger`）。

## 语言

每行一条语句，`#` 为注释，标签写作 `name:`：

```
let i = 1        # 或 i = 1
print expr
if expr goto label
goto label
end
```

表达式：整数、`+ - * / %`、比较 `< <= > >= == !=`、一元 `- !`、括号。
表达式**无副作用**（无赋值、无输出），这是条件断点纯度的结构保证。

## 调试语义（确定性）

- **执行前求值**：每条语句执行前，先求值该 PC 处的断点条件；条件为真则
  停在语句执行之前（`ReasonBreakpoint`）。
- **纯条件**：`AddBreakpoint` 只接受纯表达式（`interp.IsPure`），赋值、
  `print` 等一律拒绝；条件求值不可能改变程序状态。
- **条件报错即停并保留状态**：条件求值出错（除零、未定义变量等）时以
  `ReasonCondError` 停止，语句不执行，VM 状态完全保留；删除/修复断点后
  可继续运行，结果与无调试运行一致。
- **同位置多条件按 ID 升序**：ID 单调递增；第一个为真的条件（或第一个
  求值错误）生效，其余条件不求值。
- **Continue**：执行直到断点停止、语句出错（`ReasonError`）或停机
  （`ReasonHalt`）。会重新检查当前 PC，因此恒真断点会让 Continue 立即
  再次停止——用 `Step` 或删除断点越过。
- **Step**：恰好执行一条语句，忽略断点，返回 `ReasonStep`；已停机时为
  无操作，返回 `ReasonHalt`。
- **增删断点不改变最终结果**：见等价性测试。

## 测试结果（实际运行）

`go test ./... -v -count=1`（go1.27.1 linux/amd64），18 个测试全部通过：

```
ok  	example.com/debuglib/debugger	0.005s
ok  	example.com/debuglib/interp	0.002s
```

关键测试：

- `TestBreakpointStopsBeforeStatementExecutes` — 断点停在语句执行前
- `TestConditionErrorStopsAndPreservesState` — 条件报错停止、状态保留、可恢复
- `TestConditionsAtSamePCRunInIDOrder` — 同 PC 多条件按 ID 升序
- `TestStepExecutesExactlyOneStatementIgnoringBreakpoints` — 单步语义
- `TestConditionEvaluationDoesNotMutateState` — 条件求值不改变状态
- `TestDebugRunMatchesPlainInterpreter` / `TestFuzzDebugRunMatchesPlainInterpreter`
  — 任意增删断点、交替单步/继续后，最终变量与输出和无调试解释器完全一致
  （含 100 个固定种子的确定性随机序列）
