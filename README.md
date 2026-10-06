# boolexec

布尔 AST 插桩执行器：对**实际开始求值**的节点计数，`&&`/`||` 严格短路——
绝不会为了记录而触碰右操作数；异常（panic / error）与取消发生时，已开始
节点的计数照样保留。

## 核心概念

- `Node`：布尔 AST 节点（`And` / `Or` / `Not` / `Leaf`），`ID` 在源码重写
  间保持稳定，`Label` 标识叶子身份。
- `Executor`：可复用、并发安全的执行器。`Eval(ctx, root)` 短路求值并按
  节点原子计数；叶子 panic 被转换为 `*PanicError`（计数不丢）。
- `Coverage`：按版本冻结的覆盖表（`Snapshot()`），含每节点计数与结构哈希，
  快照后不受后续求值或版本替换影响。
- `Replace(root)`：切换到新版 AST。稳定 ID 且**结构哈希不变**的节点迁移
  计数；结构改变或新增节点清零；被删除节点从表中移除。计数与替换通过
  `RWMutex` 互斥，已开始计数在竞争中不丢失。

## 示例

```go
root := boolexec.AndNode("root",
    boolexec.ConstLeaf("cheap", false),
    boolexec.LeafNode("expensive", "db-check", checkDB), // 永不执行
)
ex, _ := boolexec.NewExecutor(root)
val, err := ex.Eval(ctx, root)          // false；checkDB 未被调用
cov := ex.Snapshot()                    // cov.Count("expensive") == 0

_ = ex.Replace(newRoot)                 // 版本 +1，稳定节点计数迁移
```

## 测试

```sh
go test ./...          # 单元 + 随机 AST 对照 + 屏障竞争测试
go test -race ./...    # 竞争检测
```

- `executor_test.go`：短路不访问右项、panic/error 计已开始节点、取消保留计数。
- `random_test.go`：400 颗随机 AST 与独立参考求值器比对结果、逐节点计数与
  叶子读取副作用；并发求值计数线性一致。
- `coverage_test.go`：版本迁移/结构变更清零、冻结快照不可变、屏障下并发
  计数 × 取消 × panic × 版本替换不丢已开始计数。
