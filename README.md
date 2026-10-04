# canonenc — 规范转义编码库

纯 Go 标准库实现（`errors`/`fmt`/`crypto/hmac`/`crypto/sha256`），无第三方依赖。

## 编码规范

- 转义字节：`%`（0x25），转义形式为 `%` + 两位**大写**十六进制。
- 必转义集：控制字节 `0x00–0x1F`、DEL `0x7F`、以及 `%` 自身
  （NUL/TAB/LF/CR 等分隔符均属控制字节，一并覆盖）。
- 其余字节原样输出。每个明文字节串只有唯一合法（规范）编码。

## 解码严格性（拒绝非规范等价写法）

解码器对以下输入返回包装 `ErrInvalid` 的错误：

- 小写或混合大小写十六进制转义（如 `%0a`、`%Ff`）；
- 对非必转义字节的转义（如 `%41`、`%20`）；
- 未转义的裸控制字节 / 裸 DEL；
- 非十六进制转义字符（如 `%GG`）。

## 截断 vs 非法

- 输入末尾悬挂的转义序列（`%`、`%4`）报 `ErrIncomplete` —— 截断，续传可能补全；
- 结构性错误报 `ErrInvalid` —— 非法，与截断严格区分；
- 流式 `Decoder` 在跨块边界的部分转义上缓冲等待，`Finalize` 时才判定截断；
  非法字节一旦可判定立即报错（即使坏字节与 `%` 分属不同块）。

## 签名绑定编码后字节

`Sign(key, encoded)` = HMAC-SHA256(key, encoded)，直接作用于编码后字节。
同一明文的非规范改写会改变被签名字节而验签失败，且解码器本身也会拒绝。
`Seal`/`Open` 提供"编码+签名"与"验签后解码"的组合接口。

## 验收测试覆盖

- `TestRoundTripAllBytes`：0x00–0xFF 全部字节逐一及整体往返；
- `TestEveryTruncationPoint`：真实编码在每个长度截断，错误仅为 nil 或 `ErrIncomplete`；
- `TestStreamEverySplitPoint` / `TestStreamArbitraryChunking`：每个切分点及随机多块切分；
- `TestDoubleEncoding` / `TestStreamDoubleEncoded`：双编码输入逐层解码还原；
- `TestRejectNonCanonical`：12 类非规范/非法写法拒绝；
- `TestSignatureBindsEncodedBytes`：非规范改写、篡改、错钥、截断签名均验签失败。

## 实测结果（go1.27.1 linux/amd64）

```
$ go vet ./...        # 通过，无输出
$ go test ./...
ok  	canonenc	0.011s
$ go test -race -count=1 ./...
ok  	canonenc	1.061s
```

全部 15 个测试（含 12 个子测试与 1 个 Example）PASS。
