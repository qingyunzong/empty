package replacer

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

// scanRecord 是独立的整段参考实现：对单条记录一次扫完。
func scanRecord(d *Dict, s string, base int) []Segment {
	runes := []rune(s)
	var segs []Segment
	litStart := -1
	var lit []rune
	flush := func(end int) {
		if litStart < 0 {
			return
		}
		segs = append(segs, Segment{Start: litStart, End: end, Text: string(lit)})
		litStart, lit = -1, nil
	}
	i := 0
	for i < len(runes) {
		length, e, matched, _ := d.matchAt(runes[i:], true)
		if matched {
			flush(base + i)
			segs = append(segs, Segment{
				Start: base + i, End: base + i + length,
				Text: e.Replacement, Replaced: true,
			})
			i += length
			continue
		}
		if litStart < 0 {
			litStart = base + i
		}
		lit = append(lit, runes[i])
		i++
	}
	flush(base + i)
	return segs
}

func textOf(segs []Segment) string {
	var b strings.Builder
	for _, s := range segs {
		b.WriteString(s.Text)
	}
	return b.String()
}

func TestLongestMatch(t *testing.T) {
	d := NewDict(
		Entry{Pattern: "ab", Replacement: "X"},
		Entry{Pattern: "abc", Replacement: "Y"},
		Entry{Pattern: "a", Replacement: "Z"},
	)
	cases := map[string]string{
		"abc":   "Y",
		"ab":    "X",
		"a":     "Z",
		"abcd":  "Yd",
		"xabcy": "xYy",
	}
	for in, want := range cases {
		r := NewReplacer(d)
		r.Write([]byte(in))
		r.EndRecord()
		if got := r.Text(); got != want {
			t.Errorf("Replace(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPriorityTieBreak(t *testing.T) {
	d := NewDict(
		Entry{Pattern: "go", Replacement: "低", Priority: 1},
		Entry{Pattern: "go", Replacement: "高", Priority: 10},
		Entry{Pattern: "go", Replacement: "中", Priority: 5},
	)
	r := NewReplacer(d)
	r.Write([]byte("go go"))
	r.EndRecord()
	if got := r.Text(); got != "高 高" {
		t.Errorf("got %q, want %q", got, "高 高")
	}
}

func TestReplacementNotRescanned(t *testing.T) {
	d := NewDict(
		Entry{Pattern: "a", Replacement: "b"},
		Entry{Pattern: "b", Replacement: "c"},
		Entry{Pattern: "hello", Replacement: "hello hello"},
	)
	r := NewReplacer(d)
	r.Write([]byte("a b hello"))
	r.EndRecord()
	if got := r.Text(); got != "b c hello hello" {
		t.Errorf("got %q, want %q", got, "b c hello hello")
	}
}

func TestUnicodeCodePoints(t *testing.T) {
	d := NewDict(
		Entry{Pattern: "你好", Replacement: "您好"},
		Entry{Pattern: "你好吗", Replacement: "您好吗"},
		Entry{Pattern: "🙂🙂", Replacement: "😀"},
	)
	r := NewReplacer(d)
	r.Write([]byte("你好吗，你！🙂🙂🙂"))
	r.EndRecord()
	want := "您好吗，你！😀🙂"
	if got := r.Text(); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestIntervals(t *testing.T) {
	d := NewDict(Entry{Pattern: "世界", Replacement: "world"})
	r := NewReplacer(d)
	r.Write([]byte("你好，世界！再见"))
	r.EndRecord()
	src := []rune("你好，世界！再见")
	var rebuilt []rune
	for _, s := range r.Segments() {
		if s.Replaced {
			continue
		}
		rebuilt = append(rebuilt, src[s.Start:s.End]...)
	}
	// 所有字面段拼回应等于原文去掉被替换区间后的部分。
	want := []rune("你好，！再见")
	if string(rebuilt) != string(want) {
		t.Errorf("rebuilt %q, want %q", string(rebuilt), string(want))
	}
	// 区间应连续覆盖整个输入。
	pos := 0
	for _, s := range r.Segments() {
		if s.Start != pos {
			t.Fatalf("segment %+v starts at %d, want %d", s, s.Start, pos)
		}
		pos = s.End
	}
	if pos != len(src) {
		t.Fatalf("segments cover %d runes, input has %d", pos, len(src))
	}
}

// TestChunkedEqualsWhole 验证任意字节切块（含 UTF-8 序列中间）与
// 整段扫描结果一致。
func TestChunkedEqualsWhole(t *testing.T) {
	d := NewDict(
		Entry{Pattern: "你好", Replacement: "您好"},
		Entry{Pattern: "你好吗", Replacement: "您好吗"},
		Entry{Pattern: "ab", Replacement: "AB"},
		Entry{Pattern: "abc", Replacement: "ABC"},
		Entry{Pattern: "🙂", Replacement: ":)"},
	)
	input := "你好吗abc，你好吗？ab🙂xabc你好"
	whole := scanRecord(d, input, 0)

	// 所有单点切分，以及逐字节写入。
	splits := [][]int{{}}
	for i := 1; i < len(input); i++ {
		splits = append(splits, []int{i})
	}
	splits = append(splits, nil) // 逐字节

	for _, sp := range splits {
		r := NewReplacer(d)
		if sp == nil {
			for i := 0; i < len(input); i++ {
				r.Write([]byte{input[i]})
			}
		} else {
			prev := 0
			for _, p := range sp {
				r.Write([]byte(input[prev:p]))
				prev = p
			}
			r.Write([]byte(input[prev:]))
		}
		r.EndRecord()
		if !reflect.DeepEqual(r.Segments(), whole) {
			t.Errorf("split %v: got %v, want %v", sp, r.Segments(), whole)
		}
	}
}

// TestDictSwitchAtRecordBoundary 验证词典在记录边界切换时，
// 切块流式结果与逐条记录整段扫描的拼接一致，且匹配不跨记录。
func TestDictSwitchAtRecordBoundary(t *testing.T) {
	d1 := NewDict(Entry{Pattern: "foo", Replacement: "F"})
	d2 := NewDict(Entry{Pattern: "foobar", Replacement: "FB"}, Entry{Pattern: "bar", Replacement: "B"})
	records := []struct {
		d *Dict
		s string
	}{
		{d1, "foo"},    // 记录 1：foo -> F
		{d2, "bar"},    // 记录 2：跨边界的 "foobar" 不得匹配，bar -> B
		{d2, "foobar"}, // 记录 3：foobar -> FB
		{d1, "foofoo"},
	}
	var want []Segment
	base := 0
	for _, rec := range records {
		want = append(want, scanRecord(rec.d, rec.s, base)...)
		base += len([]rune(rec.s))
	}

	r := NewReplacer(records[0].d)
	for i, rec := range records {
		if i > 0 {
			r.SetDict(rec.d)
		}
		// 以逐字节方式写入，同时检验切块。
		for j := 0; j < len(rec.s); j++ {
			r.Write([]byte{rec.s[j]})
		}
	}
	r.EndRecord()
	if !reflect.DeepEqual(r.Segments(), want) {
		t.Errorf("got  %v\nwant %v", r.Segments(), want)
	}
	if got, w := r.Text(), textOf(want); got != w {
		t.Errorf("got %q, want %q", got, w)
	}
	if r.Text() != "FBFBFF" {
		t.Errorf("text = %q, want %q", r.Text(), "FBFBFF")
	}
}

// TestRandomChunkConsistency 随机输入、随机切块、随机记录边界换词典，
// 与逐记录整段扫描对比。
func TestRandomChunkConsistency(t *testing.T) {
	dicts := []*Dict{
		NewDict(
			Entry{Pattern: "ab", Replacement: "X"},
			Entry{Pattern: "abc", Replacement: "Y"},
			Entry{Pattern: "你", Replacement: "N"},
		),
		NewDict(
			Entry{Pattern: "bc", Replacement: "Z"},
			Entry{Pattern: "你好", Replacement: "W", Priority: 2},
			Entry{Pattern: "你好", Replacement: "w", Priority: 1},
		),
	}
	alphabet := []string{"a", "b", "c", "你", "好", "d"}
	rng := rand.New(rand.NewSource(42))

	for trial := 0; trial < 300; trial++ {
		// 生成随机记录序列。
		type rec struct {
			d *Dict
			s string
		}
		var records []rec
		var want []Segment
		base := 0
		for k := 0; k < 1+rng.Intn(4); k++ {
			var sb strings.Builder
			for n := 0; n < rng.Intn(20); n++ {
				sb.WriteString(alphabet[rng.Intn(len(alphabet))])
			}
			d := dicts[rng.Intn(len(dicts))]
			records = append(records, rec{d, sb.String()})
			want = append(want, scanRecord(d, sb.String(), base)...)
			base += len([]rune(sb.String()))
		}

		// 随机字节块写入。
		r := NewReplacer(records[0].d)
		for i, rc := range records {
			if i > 0 {
				r.SetDict(rc.d)
			}
			s := rc.s
			for len(s) > 0 {
				n := 1 + rng.Intn(len(s))
				r.Write([]byte(s[:n]))
				s = s[n:]
			}
		}
		r.EndRecord()

		if !reflect.DeepEqual(r.Segments(), want) {
			t.Fatalf("trial %d:\ngot  %v\nwant %v", trial, r.Segments(), want)
		}
	}
}

func TestEmptyAndNoMatch(t *testing.T) {
	d := NewDict(Entry{Pattern: "x", Replacement: "X"})
	r := NewReplacer(d)
	r.Write([]byte(""))
	r.EndRecord()
	if got := r.Text(); got != "" {
		t.Errorf("got %q, want empty", got)
	}
	r2 := NewReplacer(d)
	r2.Write([]byte("没有匹配"))
	r2.EndRecord()
	if got := r2.Text(); got != "没有匹配" {
		t.Errorf("got %q, want %q", got, "没有匹配")
	}
}
