# IMAP BODY 分段重组

可导入的 Go 库，用于归档服务重组 IMAP `FETCH BODY[section]<origin.length>`
分段 literal。实现位于包 `dataeng`，核心类型是 `Message`。

## 行为

- 以 `section` 为独立键，按 `origin` 偏移和 `len(Data)`（服务器实际返回的
  literal 长度）拼接；支持乱序、相邻合并和任意重叠。
- 重叠区字节完全相同时幂等接收；任一字节不同则返回 `*ConflictError`，并使
  当前消息永久失败。其他 section 已收到的数据仍可单独读取。
- 空洞通过 `Gaps`/`SectionStatus` 报告，不会误判为完成。
- 短 literal 会记录在 `ShortLiterals` 中。已知 section 期望大小时，或已有更
  靠后的数据证明 section 尚未结束时，未到达 section 末尾的短 literal 记为
  `Truncated`，并给出 `Truncations` 明细。
  `Check(section)` 可将冲突、截短和空洞分别返回为 `ErrConflict`、
  `ErrTruncated`、`ErrIncomplete`/`ErrGap`。
- section 完成条件为：已知期望大小，且实际字节连续覆盖 `[0, expected)`；
  不依赖 FETCH 请求长度之和。
- 每个 section 有独立锁和状态，并发抓取不同 section 互不干扰。

## 用法

```go
message := dataeng.NewMessage()
if err := message.Expect("1", 11); err != nil { // 来自 BODYSTRUCTURE
    return err
}

// 可以乱序、并发提交；RequestedLength 是 FETCH 请求的长度。
_ = message.AddPartial("1", 6, 5, []byte("world"))
_ = message.AddPartial("1", 0, 6, []byte("hello "))

body, err := message.SectionBytes("1") // "hello world"
if err != nil {
    return err
}
```

`Expect` 是完成判定的前提。若只把请求长度累加为目标，服务器截短会留下空洞却
被误判完成，因此本库不会仅凭 `RequestedLength` 宣布完成。没有期望大小时，
`SectionComplete` 恒为 false，`SectionBytes` 返回 `ErrExpectedSizeUnknown`。

一次性重组可使用：

```go
bodies, err := dataeng.Reassemble(segments, map[dataeng.Section]int64{"1": 11})
```

完整 API 见 `go doc`。
