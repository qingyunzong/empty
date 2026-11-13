# 多句报文的填充位

船舶采集调用可导入的 Go 包重组多句报文，不接收电台。每句带总句数、句序和填充位数。同一消息的总句数必须一致，句序必须从 1 连续。填充位只允许出现在最后一句，去掉填充后的比特数必须是 6 的倍数。校验失败的句子丢掉，并使所属消息失败。缺句是否超时由调用方时钟决定。

`dataeng` 只处理调用方交来的报文片段，不做任何网络、串口或电台 I/O。

## 基本用法

```go
assembler := dataeng.NewAssembler(2 * time.Second)

// 片段可以乱序到达。MessageID 由调用方分配。
result := assembler.Add(dataeng.Sentence{
    MessageID: "voyage-42",
    Total:     2,
    Number:    2,
    FillBits:  2,
    Bits:      []byte{1, 0, 1, 1, 0, 0, 1, 0}, // 每字节只能是 0 或 1
}, now)

if result.Status == dataeng.StatusComplete {
    // result.Message.Bits 已去掉最后一句的填充位。
}
```

调用方显式推进时钟并检查缺句：

```go
for _, expired := range assembler.Expire(now) {
    // expired.Missing 是被丢弃消息缺少的句序。
}
```

`NewAssembler` 也接受一个可选的 `Clock`；`Add`、`Expire` 也可以带显式时间。包本身不启动定时器。非正超时表示不超时。

## 校验规则

- 同一 `MessageID` 的所有片段必须报告相同的 `Total`。
- 句序从 1 到 `Total` 必须各出现一次；重复句序使消息失败。
- 只有 `Number == Total` 的句子可以带非零 `FillBits`。
- 组装后先去掉最后一句的 `FillBits`，剩余比特数必须能被 6 整除。
- 任意校验失败的句子被丢弃，其消息立即失败；后续片段不能使该消息复活，除非调用 `Forget` 或超时后复用该 ID。

可选的 `ParseNMEA`/`AddLine` 支持 `!AIVDM`/`!AIVDO` 形式的输入并校验和的 NMEA 校验和；电台信道字段被忽略。核心 `Assembler` 不依赖 NMEA。

## 测试

`reassemble_test.go` 使用独立的比特模型，从源 6 比特值直接计算期望比特流，并覆盖乱序、末句填充、非末句填充、6 的倍数校验、缺句超时和失败后不可复活等场景。期望值不调用被测包的组装或解码逻辑生成。
