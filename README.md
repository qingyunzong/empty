采集SDK需要可导入的Go批量响应组件，输入已解析的响应分段，每段有Content-ID、状态码、JSON值及可指向其他分段的JSON Pointer引用。分段可乱序，一个事务组内所有依赖闭合后才交给调用方；失败状态使所有传递依赖项失败，环单独报告。引用解析按RFC6901，插入的是不可变深拷贝，禁止引用自身后代引发无限展开；设展开节点预算，超限整组拒绝。用重复ID冲突、菱形共享、转义路径和失败段迟到测试，核对结果不依赖到达顺序。

## batchresp

实现位于可导入子包 `batchresp`（导入路径 `example.com/dlks/q155/batchresp`）。

### 核心模型

- `Segment`：已解析的响应分段，含 `ContentID`、`StatusCode`、`Value`（`encoding/json`
  解码后的值）以及显式 `Refs`。引用也可以内嵌为单键对象 `{"$ref": "<id>#<pointer>"}`，
  标记键可通过 `WithRefKey` 替换。
- `Group`：单事务组的乱序装配器，非并发安全；`Add` 入口即深拷贝并解析全部引用。
- `Resolver`：带互斥锁的流式入口，分段并发到达时在依赖闭合那一刻回调 `OnGroupClosed`，
  每组恰好交付一次，失败分段迟到同样会触发交付。
- `Result`：`Values`（成功段的完整物化深拷贝）、`Failed`（直接失败及全部传递依赖）、
  `Cycles`（独立报告的环）和组级 `Err`（预算超限等整组拒绝场景）。

### 关键保证

- 引用文本为 `<Content-ID>#<RFC 6901 JSON Pointer>`，空指针引用整份文档；`~0`/`~1`
  转义、数组前导零、越界与 `-` 索引均按 RFC 6901 校验。
- 依赖图先做 Tarjan 强连通分量环检测，环成员在 `Cycles` 中单独报告并失败，其传递
  依赖一并失败；展开器另带后代栈，防御引用自身后代导致的无限展开。
- 状态码达到阈值（默认 `>=400`，`WithFailStatusThreshold` 可调）即失败，并沿反向
  依赖边传播到所有传递依赖项；成功段与失败段互不影响。
- 物化输出和入口输入都是独立深拷贝，菱形/共享依赖在每条引用处生成独立子树，调用方
  修改结果不会污染存储状态，重复 `Resolve` 结果一致。
- `WithNodeBudget` 限制物化产生的 JSON 节点总数（共享展开按实际产出重复计数），超限
  立即返回 `ErrBudgetExceeded`，不做部分交付。
- 所有遍历按 Content-ID 排序，重复 ID 以 `ErrDuplicateID` 拒绝且不覆盖先到分段，
  因此结果与分段到达顺序无关。

### 用法

```go
group := batchresp.NewGroup("tx-1", batchresp.WithNodeBudget(10_000))
_ = group.Add(batchresp.Segment{
    ContentID:  "user",
    StatusCode: 200,
    Value:      map[string]any{"profile": map[string]any{"$ref": "profile#/data"}},
})
_ = group.Add(batchresp.Segment{
    ContentID:  "profile",
    StatusCode: 200,
    Value:      map[string]any{"data": map[string]any{"name": "ada"}},
})
result := group.Resolve() // Pending 为空时即可调用
```

流式场景使用 `NewResolver(func(batchresp.Result) { ... })` 后并发调用 `Add`。

### 测试

`go test ./... -race -count=10` 覆盖重复 ID 冲突、菱形共享深拷贝、RFC 6901 转义
路径、失败段迟到的传递失败、环/自环单独报告、节点预算整组拒绝、不可变性以及全排列
乱序到达的顺序无关性。
