# textreplace

按 Unicode 码点做词典最长匹配的文本替换库，仅依赖 Go 标准库。

## 语义

- **最长匹配**：每个扫描位置取能命中的最长 Key（按码点计）。
- **优先级**：相同 Key 冲突时保留 `Priority` 最高者，与加入顺序无关。
- **替换串不再扫描**：命中的替换结果直接输出，不参与后续匹配。
- **原区间**：每个输出 `Piece` 记录其在原始输入中的码点区间 `[Start, End)`。
- **流式**：`Stream` 自动保留不足以判定的尾部（当前缓冲恰为某个更长
  Key 的前缀时等待更多输入），任意切块写入的结果与整段扫描一致。
- **词典切换**：`SetDict` 在记录边界（两次 `Write` 之间）生效；
  每个位置使用其所在段的词典，跨越边界的匹配沿用起点所在段的词典。

## 用法

```go
d := replacer.NewDict(
    replacer.Entry{Key: "你好", Value: "Hello"},
    replacer.Entry{Key: "你", Value: "您", Priority: 1},
)
out := replacer.ReplaceString(d, "你好吗") // "Hello吗"

// 流式 + 记录边界切换词典
st := replacer.NewStream()
st.SetDict(d1)
pieces := st.Write("记录一")
st.SetDict(d2)
pieces = append(pieces, st.Write("记录二")...)
pieces = append(pieces, st.Flush()...)
```

## 测试结果

`go test ./...`（go1.27.1 linux/amd64，2026-10-05）实际输出：

```
=== RUN   TestLongestMatch
--- PASS: TestLongestMatch (0.00s)
=== RUN   TestPriorityOnSameKey
--- PASS: TestPriorityOnSameKey (0.00s)
=== RUN   TestReplacementNotRescanned
--- PASS: TestReplacementNotRescanned (0.00s)
=== RUN   TestUnicodeIntervals
--- PASS: TestUnicodeIntervals (0.00s)
=== RUN   TestEmptyKeyIgnored
--- PASS: TestEmptyKeyIgnored (0.00s)
=== RUN   TestNilDictPassthrough
--- PASS: TestNilDictPassthrough (0.00s)
=== RUN   TestChunkedEqualsWhole
--- PASS: TestChunkedEqualsWhole (0.00s)
=== RUN   TestMatchSpanningChunkBoundary
--- PASS: TestMatchSpanningChunkBoundary (0.00s)
=== RUN   TestDictSwitchAtRecordBoundary
--- PASS: TestDictSwitchAtRecordBoundary (0.00s)
=== RUN   TestMatchSpanningDictSwitch
--- PASS: TestMatchSpanningDictSwitch (0.00s)
=== RUN   TestStreamOffsetsAcrossWrites
--- PASS: TestStreamOffsetsAcrossWrites (0.00s)
PASS
ok  	textreplace/replacer	0.004s
```
