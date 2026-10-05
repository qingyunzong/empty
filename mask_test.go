package mask

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestMergeRanges(t *testing.T) {
	cases := []struct {
		name string
		in   []Range
		want []Range
	}{
		{"空输入", nil, nil},
		{"空范围被丢弃", []Range{{3, 3}, {5, 2}}, nil},
		{"不重叠", []Range{{1, 3}, {5, 7}}, []Range{{1, 3}, {5, 7}}},
		{"重叠求并", []Range{{1, 4}, {3, 8}}, []Range{{1, 8}}},
		{"相邻求并", []Range{{1, 4}, {4, 8}}, []Range{{1, 8}}},
		{"包含关系", []Range{{1, 10}, {3, 5}}, []Range{{1, 10}}},
		{"乱序输入", []Range{{9, 12}, {1, 4}, {3, 10}}, []Range{{1, 12}}},
		{"多重重叠", []Range{{0, 2}, {1, 3}, {2, 5}, {8, 9}, {9, 10}}, []Range{{0, 5}, {8, 10}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := MergeRanges(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("got %v, want %v", got, c.want)
				}
			}
		})
	}
}

const sample = "name=alice; id=12345678; city=hangzhou"

func TestMaskSameLength(t *testing.T) {
	// "alice" 位于 [5, 10)，"12345678" 位于 [15, 23)
	out, pm, err := Mask([]byte(sample), []Range{{5, 10}, {15, 23}}, Options{Mode: ModeSameLength})
	if err != nil {
		t.Fatal(err)
	}
	want := "name=*****; id=********; city=hangzhou"
	if string(out) != want {
		t.Fatalf("got %q, want %q", out, want)
	}
	if len(out) != len(sample) {
		t.Fatalf("同长替换改变了长度: %d != %d", len(out), len(sample))
	}
	// 非敏感字节原样保留，位置图恒等。
	for i := 0; i < len(sample); i++ {
		inField := (i >= 5 && i < 10) || (i >= 15 && i < 23)
		if !inField && out[i] != sample[i] {
			t.Fatalf("非敏感字节 %d 被修改", i)
		}
		if !inField && pm.OrigToOut(i) != i {
			t.Fatalf("保留段位置图非恒等: OrigToOut(%d)=%d", i, pm.OrigToOut(i))
		}
	}
}

func TestMaskDigest(t *testing.T) {
	out, pm, err := Mask([]byte(sample), []Range{{5, 10}, {15, 23}}, Options{Mode: ModeDigest})
	if err != nil {
		t.Fatal(err)
	}
	sum1 := sha256.Sum256([]byte("alice"))
	sum2 := sha256.Sum256([]byte("12345678"))
	want := "name=[sha256:" + hex.EncodeToString(sum1[:]) + "]; id=[sha256:" + hex.EncodeToString(sum2[:]) + "]; city=hangzhou"
	if string(out) != want {
		t.Fatalf("got %q, want %q", out, want)
	}
	// 双向位置图：字段后的保留字节偏移应平移 digest 与原文的长度差。
	shift1 := len("[sha256:]") + 64 - 5
	if got := pm.OrigToOut(11); got != 11+shift1 {
		t.Fatalf("OrigToOut(11)=%d, want %d", got, 11+shift1)
	}
	if got := pm.OutToOrig(11 + shift1); got != 11 {
		t.Fatalf("OutToOrig(%d)=%d, want 11", 11+shift1, got)
	}
	// 脱敏段内部映射钳制到段边界。
	if got := pm.OrigToOut(7); got != 5 {
		t.Fatalf("脱敏段内 OrigToOut(7)=%d, want 5", got)
	}
	if got := pm.OutToOrig(6); got != 5 {
		t.Fatalf("替换文本内 OutToOrig(6)=%d, want 5", got)
	}
	// 末尾钳制。
	if got := pm.OrigToOut(len(sample) + 100); got != len(out) {
		t.Fatalf("末尾钳制 OrigToOut=%d, want %d", got, len(out))
	}
	if got := pm.OutToOrig(len(out) + 100); got != len(sample) {
		t.Fatalf("末尾钳制 OutToOrig=%d, want %d", got, len(sample))
	}
}

func TestMaskOverlappingRangesUnion(t *testing.T) {
	src := []byte("0123456789abcdef")
	out, _, err := Mask(src, []Range{{2, 6}, {4, 9}, {12, 13}}, Options{Mode: ModeSameLength})
	if err != nil {
		t.Fatal(err)
	}
	want := "01*******9ab*def"
	if string(out) != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestMaskRequiresExplicitMode(t *testing.T) {
	if _, _, err := Mask([]byte("abc"), []Range{{0, 1}}, Options{}); err != ErrModeUnset {
		t.Fatalf("未显式选择策略应返回 ErrModeUnset, got %v", err)
	}
}

func TestMaskInvalidRanges(t *testing.T) {
	src := []byte("abc")
	for _, r := range []Range{{-1, 2}, {1, 5}, {3, 2}} {
		if _, _, err := Mask(src, []Range{r}, Options{Mode: ModeSameLength}); err == nil {
			t.Fatalf("范围 %v 应报错", r)
		}
	}
}

func TestMaskCustomMaskByte(t *testing.T) {
	out, _, err := Mask([]byte("secret"), []Range{{0, 6}}, Options{Mode: ModeSameLength, MaskByte: '#'})
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "######" {
		t.Fatalf("got %q", out)
	}
}

// chunkSizes 返回把 n 拆成大小不超过 size 的切块。
func chunkSizes(n, size int) []int {
	var out []int
	for n > 0 {
		s := size
		if s > n {
			s = n
		}
		out = append(out, s)
		n -= s
	}
	return out
}

// TestStreamMatchesFull 切块输入的结果必须与全量 Mask 完全一致（输出与位置图）。
func TestStreamMatchesFull(t *testing.T) {
	src := []byte("header|token=abcd1234efgh|mid|secret=pa55w0rd!|tail-end")
	ranges := []Range{{14, 26}, {42, 51}, {36, 40}} // 含重叠，先求并
	for _, mode := range []Mode{ModeSameLength, ModeDigest} {
		opts := Options{Mode: mode}
		full, fullPM, err := Mask(src, ranges, opts)
		if err != nil {
			t.Fatal(err)
		}
		for _, size := range []int{1, 2, 3, 5, 7, 13, len(src)} {
			var buf bytes.Buffer
			st, err := NewStreamer(&buf, ranges, opts)
			if err != nil {
				t.Fatal(err)
			}
			off := 0
			for _, n := range chunkSizes(len(src), size) {
				if _, err := st.Write(src[off : off+n]); err != nil {
					t.Fatalf("mode=%d size=%d: %v", mode, size, err)
				}
				off += n
			}
			if err := st.Close(); err != nil {
				t.Fatalf("mode=%d size=%d: %v", mode, size, err)
			}
			if !bytes.Equal(buf.Bytes(), full) {
				t.Fatalf("mode=%d size=%d: 流式输出 %q != 全量 %q", mode, size, buf.Bytes(), full)
			}
			stPM := st.PositionMap()
			for i := 0; i <= len(src)+2; i++ {
				if stPM.OrigToOut(i) != fullPM.OrigToOut(i) {
					t.Fatalf("mode=%d size=%d: OrigToOut(%d) 不一致", mode, size, i)
				}
			}
			for i := 0; i <= len(full)+2; i++ {
				if stPM.OutToOrig(i) != fullPM.OutToOrig(i) {
					t.Fatalf("mode=%d size=%d: OutToOrig(%d) 不一致", mode, size, i)
				}
			}
		}
	}
}

// TestStreamNoLeakBeforeFieldComplete 敏感字段未完整到达前，
// 输出中不得出现该字段的任何原文片段，也不得提前出现替换内容。
func TestStreamNoLeakBeforeFieldComplete(t *testing.T) {
	src := []byte("prefix::supersecretvalue::suffix")
	field := []byte("supersecretvalue") // [8, 24)
	ranges := []Range{{8, 24}}
	for _, mode := range []Mode{ModeSameLength, ModeDigest} {
		var buf bytes.Buffer
		st, err := NewStreamer(&buf, ranges, Options{Mode: mode})
		if err != nil {
			t.Fatal(err)
		}
		// 逐字节喂入，每次检查已输出内容。
		for i := 0; i < len(src); i++ {
			if _, err := st.Write(src[i : i+1]); err != nil {
				t.Fatal(err)
			}
			got := buf.Bytes()
			if i+1 < 24 { // 字段尚未完整到达
				if bytes.Contains(got, field[:2]) {
					t.Fatalf("mode=%d 偏移 %d: 未判定字段原文泄露: %q", mode, i, got)
				}
				if mode == ModeDigest && bytes.Contains(got, []byte("[sha256:")) {
					t.Fatalf("mode=%d 偏移 %d: 摘要提前输出: %q", mode, i, got)
				}
				if mode == ModeSameLength && bytes.Count(got, []byte("*")) > 0 {
					t.Fatalf("mode=%d 偏移 %d: 遮盖字节提前输出: %q", mode, i, got)
				}
			}
		}
		if err := st.Close(); err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(buf.Bytes(), field) {
			t.Fatalf("mode=%d: 最终输出仍含敏感原文", mode)
		}
	}
}

func TestStreamRangeBeyondInput(t *testing.T) {
	var buf bytes.Buffer
	st, err := NewStreamer(&buf, []Range{{0, 100}}, Options{Mode: ModeSameLength})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Write([]byte("short")); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err == nil {
		t.Fatal("范围超出输入总长应报错")
	}
}

func TestStreamWriteAfterClose(t *testing.T) {
	var buf bytes.Buffer
	st, err := NewStreamer(&buf, nil, Options{Mode: ModeDigest})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Write([]byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Write([]byte("x")); err == nil {
		t.Fatal("Close 后 Write 应报错")
	}
	if buf.String() != "abc" {
		t.Fatalf("无范围时输出应原样保留, got %q", buf.String())
	}
}

func TestStreamRequiresExplicitMode(t *testing.T) {
	if _, err := NewStreamer(&bytes.Buffer{}, nil, Options{}); err != ErrModeUnset {
		t.Fatalf("未显式选择策略应返回 ErrModeUnset, got %v", err)
	}
}
