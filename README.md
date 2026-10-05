# serialframe

流式串口帧解析库，仅依赖 Go 标准库。

## 帧格式

```
magic(2: AA 55) | length(2, LE) | seq(1) | payload(length) | crc16(2, LE)
```

CRC 为 CRC-16/IBM（反射多项式 0xA001，初值 0），覆盖 length+seq+payload。

## 行为保证

- **任意切块**：`Feed` 接受任意大小的块，所有切分位置解析结果一致。
- **坏 CRC 重搜**：CRC 校验失败时仅从魔数后一字节起重搜，载荷中的魔数仍可起新帧。
- **长度上限**：`length > maxPayload` 时只跳过 1 字节继续扫描，绝不按不可信长度分配缓冲。
- **内存上限**：`Feed` 返回后内部保留缓冲不超过 `MaxFrameSize()`；无魔数的垃圾流只保留魔数前缀后缀（≤1 字节）。
- **丢弃统计**：`Parser.Discarded` 精确累计被丢弃的字节数，满足 输入 = 丢弃 + 成帧消费 + 缓冲保留。

## 测试结果

`go test ./...`（go1.27.1 linux/amd64）：

```
=== RUN   TestAllSplitPositions   --- PASS   // 所有切块位置
=== RUN   TestChunkings           --- PASS   // 逐字节+随机切块
=== RUN   TestGarbageDiscard      --- PASS   // 垃圾区间精确丢弃
=== RUN   TestBadCRCResync        --- PASS   // 坏CRC从魔数后一字节重搜
=== RUN   TestOversizeLength      --- PASS   // 超限长度不分配大缓冲
=== RUN   TestMemoryBound         --- PASS   // 1MiB垃圾洪峰下保留缓冲有界
=== RUN   TestIncompleteFrameWaits --- PASS  // 半帧等待补齐
PASS
ok  	serialframe	0.018s
```
