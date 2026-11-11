Go 去标识化组件。调用方按批次提交结构化事件及规则树；每个批次绑定一个密钥版本，支持确定性重试与安全撤销。

## 使用

```go
store := newKeyStore() // 实现 q204.KeyStore
processor := q204.New(store)

batch, err := processor.StartBatch(ctx, q204.BatchRequest{
    ID: "batch-1",
    Rules: []q204.Rule{
        {Path: []string{"users", "*", "profile", "email"}, Action: q204.Action{Type: q204.ActionHMAC}},
        {Path: []string{"users", "*", "profile", "ssn"}, Action: q204.Action{Type: q204.ActionDelete}},
        {Path: []string{"users", "*", "name"}, Action: q204.Action{Type: q204.ActionReplace, Replacement: "<redacted>"}},
    },
    Events: []q204.Event{event},
})
if err != nil {
    return err
}

result, err := batch.Process(ctx)
if err != nil {
    return err // 整批拒绝，不返回部分结果
}
// 重试旧批次时复用启动时解析的密钥快照，输出字节不变。
resultAgain, err := batch.Retry(ctx)
// 撤销后本地密钥引用和密钥字节先被清除，再通知密钥库。
_ = batch.Revoke(ctx)
```

## 规则与动作

- 路径段为字面量或 `"*"`。同深度可匹配的规则中，字面量段更多者优先；同等字面量数且路径重叠但规则不同，`CompileRules` / `StartBatch` 返回 `ErrInvalidConfig`。
- `ActionDelete` 删除匹配字段；匹配值为数组时逐元素匹配，数组最终为空。
- `ActionReplace` 使用固定字符串替换；数组逐元素替换。
- `ActionHMAC` 输出 `hex(HMAC-SHA256(key, []byte(string)))`（小写十六进制）。匹配到非字符串时返回 `ErrNonStringHMAC` 并拒绝整批。
- 数组既可透明向下遍历（`users.email`），也可用 `"*"` 消费一个数组元素（`users.*.email`）。空数组不产生匹配，也不会因 HMAC 被拒绝。
- 动作执行后不再对替换结果继续匹配。

## 密钥契约

`KeyStore.Current` 返回新批次的密钥引用，`Load` 必须能解析此前返回的引用，直到显式撤销。`StartBatch` 只在规则包含 HMAC 时调用二者，并立即复制密钥字节；`Retry` 不访问密钥库。

密钥库可选实现 `BatchKeyRevoker` 或 `KeyRevoker`。`Batch.Revoke` 先设置撤销状态、清零本地引用与密钥并释放事件快照，再调用可选撤销钩子。即使钩子失败，批次仍保持撤销状态，后续 `Process` / `Retry` 一律返回 `ErrBatchRevoked`。

错误只包含字段路径和批次 ID，不包含原始敏感值；组件不记录日志。

## 测试

```sh
go test ./...
go test -race ./...
```

测试使用注入密钥库覆盖轮换与重试竞态、嵌套敏感字段、空数组、非字符串 HMAC 整批拒绝、撤销期间处理及撤销钩子失败。
