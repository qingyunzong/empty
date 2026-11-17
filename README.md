# Checkpoint 提交组件

训练框架的 checkpoint 流程通过本 Go 包把各 rank 的分片提交为一个不可变的
step manifest。原始需求：

> 训练框架需要供checkpoint流程调用的Go提交组件，各rank先上传带step与代次的分片，
> 再由协调者原子发布manifest。重试、覆盖和旧rank迟到不得混合不同step。
> 用对象存储可见性延迟与崩溃点枚举验证已发布manifest的所有分片存在且摘要匹配。

## 关键不变量

- **分片不可变**：分片 key 由 `(step, generation, rank)` 唯一确定；写入使用
  `If-None-Match`。相同内容的 retry 幂等，不同内容会得到 `ErrShardConflict`，
  必须换新代次，不能覆盖已选中的分片。
- **manifest 原子发布**：每个 step 只有一个 manifest key，协调者用
  `If-None-Match` 创建。写入前必须已读取并校验全部 rank 的分片，所以 manifest
  从“不存在”直接变为“完整”。
- **不跨 step / 代次混合**：分片头记录 `step`、`generation`、`rank`，协调者逐片
  对照 key 与 manifest 身份；旧 step 或旧代次迟到的写入落到别的 key，不会进入
  已发布 manifest。
- **发布后可验证**：manifest 为每个 rank 记录 key、SHA-256 摘要和长度。
  后置覆盖或损坏会在 `Verify`/`VerifyStep` 中表现为 `ErrDigestMismatch` 或
  `ErrCorruptShard`，而不会静默混入。

## 对象布局

```text
checkpoints/step-<20位step>/manifest.json
checkpoints/step-<20位step>/gen-<20位generation>/rank-<6位rank>.shard
```

分片对象格式为 `CKP1 | uint32 头长度 | JSON 头 | payload`。分片头包含格式版本、
step、代次、rank、payload 的 SHA-256 和长度。

## 使用

```go
import formal "example.org/dlks/formal/q10186"

store := formal.NewMemStore(0) // 生产环境替换为对象存储适配器

for rank, payload := range payloads {
    uploader := &formal.Uploader{
        Store: store, Step: step, Generation: generation, Rank: rank,
    }
    if _, err := uploader.Upload(ctx, payload); err != nil {
        return err
    }
}

result, err := (&formal.Coordinator{
    Store: store, Step: step, Generation: generation, Ranks: len(payloads),
}).Commit(ctx)
if err != nil {
    return err
}
// result.Created 表示本次调用是否真正发布了 manifest。
// 若同一 step 已被其他代次发布，返回 *formal.StepCommittedError。
```

## 存储契约

`formal.Store` 要求：

- `Put` 原子，且条件写（`IfNoneMatch` / `IfMatch`）对最新已提交状态求值；
- `Get` 允许最终一致，成功写入后短期内可能返回 `ErrNotFound`。

`RetryPolicy` 控制读取重试。`MemStore` 用逻辑时钟模拟可见性延迟（每次 Get 消耗
一个逻辑操作），因此测试无需 sleep。

## 验证

```text
go test ./...
go test -race ./...
```

测试覆盖：

- 幂等重试、同代次覆盖拒绝、旧 step / 旧代次 rank 迟到；
- 可见性延迟下“分片未全部可见时绝不发布 manifest”，以及 manifest/分片读取最终可见；
- 并发协调者只有一个能创建 manifest；
- **崩溃点枚举**：对上传与提交流程中的每个存储操作，分别枚举“操作前崩溃”和
  “操作已持久化但未收到确认”两种崩溃；每个崩溃点后立即检查：若 manifest 已存在，
  其列出的所有分片必须存在且摘要/长度匹配；重启重试后 manifest 保持不变且可验证。
