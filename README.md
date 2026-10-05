# objstore

对象 API 库：内部整数句柄通过随机外部 token 暴露，token 内嵌租户与代
（generation）。仅使用 Go 标准库。

## 设计

- **Token 格式**：`v1.<hex租户>.<hex代>.<hex句柄>.<hex随机nonce>`，
  由 `Parse` 可无状态解码；nonce 来自可注入的 `*rand.Rand`
  （`NewStore(rng)` / `NewStoreWithSeed(seed)`），测试可完全确定。
- **句柄复用与 ABA 防护**：删除后句柄进入 LIFO 空闲栈；复用时代自增，
  旧 token 因代不匹配且已从映射中移除而永久失效，ID 复用不会复活。
- **租户隔离**：每次访问校验 token 内嵌租户与调用方租户；跨租户返回
  `ErrUnauthorized`（与 `ErrInvalidToken` 可区分）。
- **批量读取**：`GetBatch` 先校验全部 token，任一无效或未授权则整批
  失败，不返回部分结果，无副作用。

## API

- `NewStore(rng *rand.Rand)` / `NewStoreWithSeed(seed int64)`
- `Create(tenant string, data []byte) Token`
- `Get(tenant string, tok Token) (Object, error)`
- `GetBatch(tenant string, toks []Token) ([]Object, error)` — 全有或全无
- `Delete(tenant string, tok Token) error`
- `Parse(tok Token) (Info, error)` — 解码租户/代/句柄

## 验收测试（store_test.go）

- `TestTokenEmbedsTenantAndGeneration` — token 含租户与代
- `TestDeleteInvalidatesToken` — 删除后旧 token 失效
- `TestABAHistory` — 句柄三轮复用（gen1→2→3），历史 token 全部失效
- `TestCrossTenantDenied` / `TestCrossTenantTokenIsNotSilentlyInvalid` — 跨租户拒绝
- `TestBatchReadAllOrNothing` — 批内任一未授权/失效则整批失败
- `TestSeededRNGIsDeterministic` — 同种子同 token 序列
- `TestMalformedToken` — 畸形 token 拒绝

## 实际测试结果

```
$ go test ./...
ok  	objstore	0.007s

$ go test -race ./...
ok  	objstore	1.029s
```

9 个测试全部通过（Go 1.27.1, linux/amd64）。
