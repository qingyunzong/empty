# bdd

Go 实现的 ROBDD（约简有序二叉决策图）库，仅使用标准库。

## 特性

- **固定变量序**：`Manager` 持有全局变量序（level → variable），所有节点按序构造。
- **布尔运算**：`And` / `Or` / `Xor` / `Nand` / `Nor` / `Implies` / `Not` / `Ite`，基于 Shannon 展开的 `apply` + 计算缓存。
- **存在量化**：`Exists(h, vars...)`，对量化变量做 `Or` 归约。
- **重新排序**：`Reorder(perm)` 通过穷举 Shannon 展开（变量数 ≤ 16）把所有存活句柄重建为新序下的规范 BDD；**旧句柄仍代表原函数**（真值表不变），旧序节点由 GC 回收。
- **节点归一共享**：唯一表（unique table）以 `(var, low, high)` 为键，结构相同的函数共享同一节点；`low == high` 自动归约。
- **引用计数释放**：句柄 `Free()` 只减少引用计数；引用归零才从唯一表删除并级联释放子节点，**仍被其他句柄/父节点引用的活节点绝不删除**。`GC()` 回收无引用的中间节点。

## 约束

- 变量数 `numVars ∈ [0, 16]`（`MaxVars`），越界返回错误。
- 非并发安全。

## 测试

每个操作均以完整真值表（全部 2^n 赋值）核对，含 16 变量（65536 赋值）的奇偶/合取/存在量化用例。

实际运行结果（go1.27.1 linux/amd64）：

```
$ go test ./...
ok  	bdd	0.028s
```

全部 8 个测试通过：`TestNewManagerLimits`、`TestConstAndVar`、`TestBoolOps`（11 个子用例）、`TestExists`、`TestSharing`、`TestFreeKeepsLiveNodes`、`TestReorder`（含 5 个句柄重排后真值表不变）、`TestReorderInvalid`、`TestSixteenVars`。
