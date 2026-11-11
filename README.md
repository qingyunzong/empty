网络采集服务需要可导入的Go pcapng读取组件，支持Section Header、Interface Description和Enhanced Packet块，未知块按长度跳过。每节独立字节序与接口编号，接口时间分辨率可为十进制或二进制指数，时间戳以精确有理秒交给调用方。核对块头尾总长相等、四字节对齐、捕获长度不大于原长和数据边界，选项按各自长度跳过并校验填充；跨节不得沿用旧接口。用自行编码的混合字节序、未知块、时间精度与截断夹具逐字节切块，坏块不能发布包或污染下一节接口。

## pcapng 读取组件

可导入包位于 `pcapng/`，仅依赖 Go 标准库。

### 用法

```go
import "example.com/dlks/q208/pcapng"

rd := pcapng.NewReader(f)
for {
    pkt, err := rd.Next()
    if errors.Is(err, io.EOF) {
        break
    }
    if err != nil {
        return err // 坏块：错误即终止，不会产生半包
    }
    if pkt == nil {
        continue // SHB/IDB/未知块不产生包
    }
    // pkt.Timestamp 是 *big.Rat，精确表示有理秒
    fmt.Println(pkt.Interface, pkt.LinkType, pkt.Timestamp.RatString(), pkt.Data)
}
```

### 语义

- 支持 SHB、IDB、EPB；其余块类型按头部声明的块总长跳过。
- 每个 Section 独立解析字节序（SHB 魔数定序）与接口表，新 Section 丢弃旧接口。
- `if_tsresol` 同时支持十进制（10^-n）与二进制（2^-n）指数，缺省为 10^-6 秒。
- 时间戳以 `*big.Rat` 精确有理秒交付，避免浮点误差。
- 严格校验：块头尾总长一致、4 字节对齐、捕获长度 ≤ 原始长度、数据不越界、选项按长度跳过且填充为零。
- 任何畸形块都返回错误并使 Reader 停止，坏块既不会发布包，也不会改动接口表。

### 测试

测试夹具全部用标准库手工编码（`fixture_test.go`），覆盖混合字节序、未知块、
各类时间精度，以及对完整流逐字节截断的健壮性；运行 `go test ./...`。
