网关要接入Go查询参数中间件，保护后端同时使用首值和末值解析器的接口。调用方配置允许的键、是否可重复及值的UTF-8规则；百分号只解码一次，先按原始&与首个=分隔，+解释为空格。规范化后键碰撞、非法转义、控制字符或不可重复键出现多次时拒绝整个请求；合格结果按键和原始同键顺序重建，并保证再次解析不产生新键。实现规则热更新，单次请求固定版本；对签名校验用的原字节与后端收到的规范字节分别保留摘要。用两种后端解析适配器及双重编码、空键、分隔符编码的差分测试验收。

## 用法

```go
store, _ := q207.NewRuleStore(&q207.Rules{
    Keys: map[string]q207.KeyRule{
        "a":   {},
        "tag": {Repeatable: true},
    },
    RequireUTF8Values: true,
})
http.Handle("/", store.Middleware(backend))

// 热更新规则；在途请求继续使用各自固定的版本。
store.Update(newRules)
```

- 拒绝原因：`ErrInvalidEscape`、`ErrControlChar`、`ErrInvalidUTF8`、`ErrUnknownKey`、`ErrKeyCollision`、`ErrNotRepeatable`（`errors.Is` 可判）。
- 后端通过 `q207.FromContext(r.Context())` 获取 `Result`：规则版本、规范串、原字节摘要（签名校验用）与规范字节摘要。
- 验收测试：`go test ./... -race`，含首值/末值两种后端适配器的差分测试及双重编码、空键、分隔符编码用例。
