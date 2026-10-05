package mask

import (
	"bytes"
	"strings"
	"testing"
)

// runStream 以固定块大小流式处理 src，所有范围预先声明，
// 每次写入后提交到已接收位置，返回拼接输出与位置图。
func runStream(t *testing.T, src []byte, ranges []Range, opts Options, chunk int) ([]byte, PosMap) {
	t.Helper()
	s := NewStreamer(opts)
	for _, r := range ranges {
		if err := s.AddRange(r); err != nil {
			t.Fatalf("AddRange: %v", err)
		}
	}
	var out []byte
	for i := 0; i < len(src); i += chunk {
		end := i + chunk
		if end > len(src) {
			end = len(src)
		}
		s.Write(src[i:end])
		piece, err := s.Commit(end)
		if err != nil {
			t.Fatalf("Commit: %v", err)
		}
		out = append(out, piece...)
	}
	rest, pm, err := s.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	out = append(out, rest...)
	return out, pm
}

// TestStreamMatchesOneShot 切块输入的最终结果必须与全量一次性结果一致。
func TestStreamMatchesOneShot(t *testing.T) {
	src := []byte(sample)
	for _, strategy := range []Strategy{SameLength, Digest} {
		opts := Options{Strategy: strategy}
		full, fullPM, err := Mask(src, sampleRanges(), opts)
		if err != nil {
			t.Fatalf("Mask: %v", err)
		}
		for _, chunk := range []int{1, 2, 3, 5, 7, 16, 64, len(sample)} {
			got, gotPM := runStream(t, src, sampleRanges(), opts, chunk)
			if !bytes.Equal(got, full) {
				t.Fatalf("strategy=%d chunk=%d: stream %q != one-shot %q", strategy, chunk, got, full)
			}
			// 位置图等价：抽样偏移双向映射一致。
			for o := 0; o <= len(src); o += 3 {
				if gotPM.ToMasked(o) != fullPM.ToMasked(o) {
					t.Fatalf("strategy=%d chunk=%d: ToMasked(%d) %d != %d",
						strategy, chunk, o, gotPM.ToMasked(o), fullPM.ToMasked(o))
				}
			}
			for m := 0; m <= len(full); m += 3 {
				if gotPM.ToOrig(m) != fullPM.ToOrig(m) {
					t.Fatalf("strategy=%d chunk=%d: ToOrig(%d) %d != %d",
						strategy, chunk, m, gotPM.ToOrig(m), fullPM.ToOrig(m))
				}
			}
		}
	}
}

// TestStreamNoLeakBeforeDecision 敏感字段跨块时，判定未完成前不得输出其任何字节。
func TestStreamNoLeakBeforeDecision(t *testing.T) {
	src := []byte(sample)
	pwStart := strings.Index(sample, "secret123")
	pwEnd := pwStart + len("secret123")

	s := NewStreamer(Options{Strategy: SameLength})
	if err := s.AddRange(Range{pwStart, pwEnd}); err != nil {
		t.Fatalf("AddRange: %v", err)
	}
	// 第一块在敏感字段中间截断。
	cut := pwStart + 4
	s.Write(src[:cut])
	out1, err := s.Commit(cut)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	// 已提交到 cut，但敏感范围跨越输出边界，必须整段滞留：
	// 输出只能覆盖敏感字段起点之前的内容。
	if len(out1) != pwStart {
		t.Fatalf("emitted %d bytes, want holdback at %d", len(out1), pwStart)
	}
	if bytes.Contains(out1, []byte("secr")) || bytes.Contains(out1, []byte("****")) {
		t.Fatalf("undecided field leaked: %q", out1)
	}
	// 剩余部分到达后，整段一次性遮盖输出。
	s.Write(src[cut:])
	out2, err := s.Commit(len(src))
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	rest, _, err := s.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	full, _, err := Mask(src, []Range{{pwStart, pwEnd}}, Options{Strategy: SameLength})
	if err != nil {
		t.Fatalf("Mask: %v", err)
	}
	got := append(append(out1, out2...), rest...)
	if !bytes.Equal(got, full) {
		t.Fatalf("stream %q != one-shot %q", got, full)
	}
}

// TestStreamRangeAwaitingBytes 范围可先于其字节声明，字节到达前不输出。
func TestStreamRangeAwaitingBytes(t *testing.T) {
	src := []byte(sample)
	s := NewStreamer(Options{Strategy: Digest})
	if err := s.AddRange(Range{10, 20}); err != nil {
		t.Fatalf("AddRange: %v", err)
	}
	s.Write(src[:5])
	out, err := s.Commit(5)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if string(out) != string(src[:5]) {
		t.Fatalf("prefix before any sensitive range should pass through, got %q", out)
	}
	s.Write(src[5:15])
	out, err = s.Commit(15)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	// 提交点落在敏感范围 [10,20) 内，回退到 10，只放行 [5,10)。
	if string(out) != string(src[5:10]) {
		t.Fatalf("expected holdback at range start, got %q", out)
	}
}

// TestStreamLateDiscovery 判定按前缀推进：提交后不允许再声明更早的范围。
func TestStreamLateDiscovery(t *testing.T) {
	src := []byte(sample)
	s := NewStreamer(Options{Strategy: SameLength})
	s.Write(src[:10])
	if _, err := s.Commit(10); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := s.AddRange(Range{5, 8}); err == nil {
		t.Fatal("expected error: range starts before committed offset")
	}
	if _, err := s.Commit(5); err == nil {
		t.Fatal("expected error: commit offset regressed")
	}
	if _, err := s.Commit(len(src) + 1); err == nil {
		t.Fatal("expected error: commit beyond buffered input")
	}
	if _, _, err := s.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if _, _, err := s.Finish(); err == nil {
		t.Fatal("expected error: Finish called twice")
	}
	if err := s.AddRange(Range{10, 12}); err == nil {
		t.Fatal("expected error: AddRange after Finish")
	}
}

// TestStreamPosMapGlobal 流式位置图使用全局（绝对）偏移。
func TestStreamPosMapGlobal(t *testing.T) {
	src := []byte(sample)
	_, pm := runStream(t, src, sampleRanges(), Options{Strategy: Digest}, 7)
	if pm.OrigLen() != len(src) {
		t.Fatalf("OrigLen = %d, want %d", pm.OrigLen(), len(src))
	}
	if pm.ToMasked(0) != 0 || pm.ToOrig(0) != 0 {
		t.Fatal("origin not mapped to origin")
	}
	if pm.ToMasked(len(src)) != pm.MaskedLen() {
		t.Fatal("end of input not mapped to end of output")
	}
}
