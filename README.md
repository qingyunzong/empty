# foldexpr

整数表达式编译/折叠库（Go）。特性：

- **常量折叠**：`Fold` 在编译期计算常量子表达式，int32 环绕语义（模 2^32）。
- **短路安全**：`&&`、`||`、`?:` 的未执行分支被直接丢弃，其中的常量除零**不会**提升为编译错误。
- **运行陷阱节点**：必执行路径上的常量除零折叠为 `Trap` 节点，运行期求值到达时返回 `*TrapError`，保留原源码中运算符的字节偏移。
- **AST 与来源输出**：`Dump` 打印带 `@offset` 位置标注的 AST 树；`String` 输出可重新解析的源码形式；`Position` 把偏移换算为行列号。
- **前后对照**：随机表达式 + 随机环境，比较折叠前后 `Eval` 的值与异常位置（`TestRandomFoldConsistency`，5 万例）。

## 示例

```go
n, _ := foldexpr.Parse("0 && 1/0") // 短路：除零在不执行分支
f := foldexpr.Fold(n)              // -> Const(0)，无错误

m, _ := foldexpr.Parse("3 + 1/0")  // 必执行的常量除零
g := foldexpr.Fold(m)              // -> 3 + Trap@4
_, err := foldexpr.Eval(g, nil)    // *TrapError，Pos=4（'/' 的偏移）
```

## 测试

```sh
go test ./...
```
