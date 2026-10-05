package replacer

import (
	"math/rand"
	"reflect"
	"testing"
)

// 把 text 按 rune 切成给定大小的块写入，收集全部片段。
func writeChunks(st *Stream, text string, sizes []int) []Piece {
	rs := []rune(text)
	var out []Piece
	i, k := 0, 0
	for i < len(rs) {
		n := sizes[k%len(sizes)]
		k++
		if n > len(rs)-i {
			n = len(rs) - i
		}
		out = append(out, st.Write(string(rs[i:i+n]))...)
		i += n
	}
	out = append(out, st.Flush()...)
	return out
}

func TestChunkedEqualsWhole(t *testing.T) {
	d := NewDict(
		Entry{Key: "a", Value: "1"},
		Entry{Key: "ab", Value: "2"},
		Entry{Key: "abc", Value: "3"},
		Entry{Key: "你好", Value: "N"},
		Entry{Key: "好世界", Value: "S"},
	)
	text := "xabcabca你好你好世界zab"
	whole := Replace(d, text)

	// 所有单切分点的两块切法
	rs := []rune(text)
	for cut := 1; cut < len(rs); cut++ {
		st := NewStream()
		st.SetDict(d)
		got := append(st.Write(string(rs[:cut])), st.Write(string(rs[cut:]))...)
		got = append(got, st.Flush()...)
		if !reflect.DeepEqual(got, whole) {
			t.Fatalf("cut=%d: got %+v, want %+v", cut, got, whole)
		}
	}

	// 随机多块切法（含逐码点）
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 200; trial++ {
		sizes := make([]int, 1+rng.Intn(4))
		for i := range sizes {
			sizes[i] = 1 + rng.Intn(5)
		}
		st := NewStream()
		st.SetDict(d)
		if got := writeChunks(st, text, sizes); !reflect.DeepEqual(got, whole) {
			t.Fatalf("sizes=%v: got %+v, want %+v", sizes, got, whole)
		}
	}
}

func TestMatchSpanningChunkBoundary(t *testing.T) {
	d := NewDict(Entry{Key: "hello", Value: "H"})
	st := NewStream()
	st.SetDict(d)
	var got []Piece
	for _, c := range []string{"h", "el", "lo", "!"} {
		got = append(got, st.Write(c)...)
	}
	got = append(got, st.Flush()...)
	want := Replace(d, "hello!")
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
	if Join(got) != "H!" {
		t.Errorf("Join = %q, want %q", Join(got), "H!")
	}
}

func TestDictSwitchAtRecordBoundary(t *testing.T) {
	d1 := NewDict(Entry{Key: "a", Value: "A"})
	d2 := NewDict(Entry{Key: "a", Value: "α"})

	// 整段（每条记录一次 Write）
	whole := NewStream()
	whole.SetDict(d1)
	p1 := whole.Write("aa")
	whole.SetDict(d2)
	p2 := whole.Write("aa")
	wholeWant := append(append(p1, p2...), whole.Flush()...)

	// 切块（记录被拆小）
	chunked := NewStream()
	chunked.SetDict(d1)
	var got []Piece
	for _, c := range []string{"a", "a"} {
		got = append(got, chunked.Write(c)...)
	}
	chunked.SetDict(d2)
	for _, c := range []string{"a", "a"} {
		got = append(got, chunked.Write(c)...)
	}
	got = append(got, chunked.Flush()...)

	if !reflect.DeepEqual(got, wholeWant) {
		t.Errorf("chunked = %+v, want %+v", got, wholeWant)
	}
	if Join(got) != "AAαα" {
		t.Errorf("Join = %q, want %q", Join(got), "AAαα")
	}
}

func TestMatchSpanningDictSwitch(t *testing.T) {
	// 匹配起点在 d1 段，跨越边界进入 d2 段，仍用 d1。
	d1 := NewDict(Entry{Key: "abcd", Value: "X"})
	d2 := NewDict(Entry{Key: "cd", Value: "Y"})
	st := NewStream()
	st.SetDict(d1)
	got := st.Write("ab")
	st.SetDict(d2)
	got = append(got, st.Write("cd")...)
	got = append(got, st.Flush()...)
	if Join(got) != "X" {
		t.Fatalf("Join = %q, want %q", Join(got), "X")
	}
	if got[0].Start != 0 || got[0].End != 4 || !got[0].Replaced {
		t.Errorf("piece = %+v, want interval [0,4) replaced", got[0])
	}
}

func TestStreamOffsetsAcrossWrites(t *testing.T) {
	d := NewDict(Entry{Key: "x", Value: "X"})
	st := NewStream()
	st.SetDict(d)
	var got []Piece
	got = append(got, st.Write("abx")...)
	got = append(got, st.Write("cdx")...)
	got = append(got, st.Flush()...)
	want := []Piece{
		{Text: "ab", Start: 0, End: 2},
		{Text: "X", Start: 2, End: 3, Replaced: true},
		{Text: "cd", Start: 3, End: 5},
		{Text: "X", Start: 5, End: 6, Replaced: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}
