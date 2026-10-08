# bchandler

字节码处理器（异常表）区间检查与有效处理器链计算工具。

## 语义

- 每个处理器保护一个**半开区间** `[start, end)`（指令下标）。
- 区间必须**层叠（laminar）**：任意两个区间要么不相交，要么一个包含另一个；
  **交叉而不嵌套**的区间会被拒绝。
- 每条指令的**有效处理器链**：覆盖该指令的处理器，**内层优先**；
  同层（区间完全相同）按**声明序号小**的优先。
- **插入指令**后重映射端点：在 `at` 前插入 `count` 条指令时，
  `start >= at` 则 `start += count`，`end > at` 则 `end += count`。
  即严格包含插入点的区间会扩展以覆盖新指令；恰好起于/止于插入点的区间不覆盖。

## 用法

```sh
go run ./cmd/bchandler [-insert at:count]... spec.json
```

spec 示例见 `testdata/example.json`：

```json
{
  "code": ["iconst_0", "istore_1"],
  "handlers": [{"name": "h0", "start": 0, "end": 2, "type": "java/lang/Throwable"}],
  "insert": [{"at": 1, "count": 2}]
}
```

`code` 给出指令助记符列表（也可用 `"length": N`）；`insert` 按顺序应用，
每个插入位置相对于当时的代码状态。报告包含校验结果、每条指令的有效
处理器链，以及每次插入后的重映射区间与新链。

## 实现与核验

- `Chain`（`handler.go`）：把层叠区间集建成包含森林，沿根到叶路径求链。
- `ChainReference`：**逐区间扫描**的参考实现；随机化测试
  （`TestChainMatchesReference*`）逐指令比对两者。
- `TestInsertPreservesChains`：随机插入后，旧指令链保持不变、
  新指令覆盖关系与"严格包含插入点"谓词一致，且重映射后区间集仍合法。

## 测试

```sh
go test ./...
```
