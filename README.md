# tailer — 追尾读取库

纯 Go 标准库实现的追尾（tail-follow）读取库：顺序跟随一个目录下按
`segment-NNNNNN.log` 编号的只追加段文件，逐条读出变长记录。

## 记录格式

```
magic   uint16  固定 0x5A54
length  uint32  载荷字节数
crc32   uint32  载荷的 IEEE CRC
payload []byte
```

## 语义

`Reader.Next()` 返回 `(Record, Status, error)`：

- **StatusRecord**：读到完整记录，游标前进；`Record.Segment`/`Offset` 标明所属段与偏移。
- **StatusWait**：尾部记录不完整（部分头或部分载荷），或暂无新数据；
  **游标保持不变**，下次 `Next` 重试同一条记录。
- **StatusFail**：游标处字节确定损坏（magic 错误、长度超限、CRC 不符，
  或轮转把记录撕裂在旧段尾部）。

**轮转**：读旧段句柄直到干净 EOF；若已存在更新段则关闭旧句柄、打开下一段
继续，否则等待后续追加。记录永不跨段。

**Writer** 提供 `Append`（整条原子写入+fsync）与 `AppendRaw`（原始字节，
测试用它把一条记录的头/尾拆成多次可观察的写入），`Rotate` 开新段。

## 测试

仅使用标准库。覆盖：逐字节/分段截断的等待与游标保持、中段 CRC 与 magic
损坏的失败、轮转时旧句柄先读完再切新段、轮转撕裂记录的失败、200 条随机
分片跨 8 段写入的无重复/无丢失/段归属核对、空目录起步等待。

实际运行结果（go1.27.1 linux/amd64）：

```
$ go test ./... -v
=== RUN   TestIncompleteTailWaits
--- PASS: TestIncompleteTailWaits (0.00s)
=== RUN   TestSplitHeaderAndBody
--- PASS: TestSplitHeaderAndBody (0.00s)
=== RUN   TestCorruptMiddleFails
--- PASS: TestCorruptMiddleFails (0.00s)
=== RUN   TestBadMagicFails
--- PASS: TestBadMagicFails (0.00s)
=== RUN   TestRotationOldHandleDrainsFirst
--- PASS: TestRotationOldHandleDrainsFirst (0.00s)
=== RUN   TestTornRecordOnRotationFails
--- PASS: TestTornRecordOnRotationFails (0.00s)
=== RUN   TestNoDupNoLossAcrossSegments
--- PASS: TestNoDupNoLossAcrossSegments (0.01s)
=== RUN   TestWaitBeforeAnySegment
--- PASS: TestWaitBeforeAnySegment (0.00s)
PASS
ok  	tailer	0.012s

$ go test ./... -race -count=2
ok  	tailer	1.068s
```
