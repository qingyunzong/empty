Go采集服务需要可嵌入的响应体处理链，支持identity、gzip和deflate，编码链按逆序解开，最多三层。调用方指定每层产出字节上限和最终总上限，恰好达到上限允许，超过一字节即终止；校验和、截断或剩余非填充尾部都应报错，结果仅在全链通过后提交给存储接口。取消必须关闭最底层正文并回收暂存。用嵌套小压缩流、拼接gzip成员、损坏尾部及中途取消验证不会提前发布或无界解压。

## 用法

```go
err := q210.Process(ctx, resp.Body,
    []string{"gzip", "deflate"},          // 按应用顺序列出，内部逆序解开
    q210.Limits{
        Layers: []int64{1 << 20, 4 << 20}, // 每层产出上限（含端点）
        Total:  1 << 20,                  // 最终总上限（含端点）
    },
    store) // 实现 q210.Store，仅在全链通过后收到一次 Commit
```

- 编码：`identity`、`gzip`（支持拼接成员与零填充尾部）、`deflate`（zlib 封装）。
- 暂存：每层产出写入 `TMPDIR` 下的临时目录，返回前一律回收；任何路径都会关闭最底层 body。
- 错误：`ErrTooManyLayers`、`ErrBadEncoding`、`ErrLimitExceeded`、`ErrTrailingData`，以及 gzip/zlib 的校验和与截断错误。
