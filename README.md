# macrolib

一个仅依赖 Go 标准库的 Lisp 风格宏库，支持：

- **参数**：`defmacro` 声明形参，调用时按位置绑定。
- **局部定义**：`let`（并行绑定，初始化式在外层环境求值）、`define`、`lambda`。
- **词法作用域**：环境为链式帧，闭包捕获定义环境而非调用环境。
- **实参先在调用环境求值**：宏实参在调用点求值为字面值后再代入模板。
- **卫生展开**：模板引入的 `lambda`/`let` 绑定一律 gensym 改名（`name#N`），
  展开式在宏的**定义环境**中求值，因此展开不能捕获调用者同名局部。
- **递归展开调用链**：`Interpreter.Trace()` 按序记录每次宏展开；
  出错时 `BudgetExceededError.Chain` 给出活动宏调用链。
- **步数预算**：`NewInterpreter(budget)` 限定求值/展开步数，预算耗尽返回
  "step budget exhausted, expansion unclosed" 及调用链。

## 运行测试

```sh
go test ./...
```

实际结果见 [TEST_RESULTS.md](TEST_RESULTS.md)。
