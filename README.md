# 套接字帧的掩码与控制帧

套接字采集若允许控制帧拆开，或者忘了先异或掩码，关闭码会变成载荷的前两字节。实现可导入的Go组件，供套接字采集调用，不建立连接。只接收客户端帧，第2字节最高位必须为1。第1字节高位是结束标记，随后3位必须为0，低4位是操作码。操作码只能是0、1、2、8、9或10。长度在第2字节低7位。126表示随后的大端uint16才是长度，且该值必须不小于126。127表示随后的大端uint64才是长度，最高位必须为0，且该值必须不小于65536。长度之后是4字节掩码，载荷的每个字节与掩码循环异或后才交付。长度大于宿主maxPayload时在长度确定后拒绝，不按声明分配。操作码8、9、10的结束标记必须为1，长度不能大于125。操作码8的载荷若非空，前两字节是大端uint16关闭码，其余必须是严格UTF-8。操作码1或2开始一条消息，随后的操作码0属于同一条消息，结束标记为1时消息完成。操作码1的完整消息必须是严格UTF-8，可以跨帧。操作码8、9、10可以插在未完成的消息之间。没有未完成消息时操作码0失败。新的1或2出现时上一条消息必须已经结束。Push可停在载荷中间；Finish时仍有未完成帧或消息则失败。失败停止组件，已交付帧保留。测试独立组帧，覆盖未做掩码异或、控制帧长度为126、续帧插在关闭帧之后和长度126的值小于126。期望帧不得调用被测组件生成。

## API

```go
decoder := dataeng.NewDecoder(maxPayload)

frames, err := decoder.Push(captureBytes)
if err != nil {
    // The decoder is stopped. Frames returned by this call were delivered
    // before the error and remain valid.
}

if err := decoder.Finish(); err != nil {
    // The capture ended in a partial frame or an incomplete message.
}
```

`Push` may receive a partial header or partial payload. It returns each wire
frame once its complete payload has arrived and has been unmasked. Fragmented
data is returned as the original `OpText`/`OpBinary` frame followed by
`OpContinuation` frames, with `Fin` set from the wire header. The decoder
validates UTF-8 over a complete text message and validates close reasons after
the two-byte close code.
