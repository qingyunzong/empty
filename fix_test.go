package utf8fix

import (
	"bytes"
	"math/rand"
	"reflect"
	"testing"
	"unicode/utf8"
)

var corpus = [][]byte{
	{},
	[]byte("hello"),
	[]byte("中文abc"),
	[]byte("\xff"),
	[]byte("\xff\xfe"),
	[]byte("a\xffb"),
	[]byte("\xe4\xb8"),            // truncated 中 at end
	[]byte("\xe4\xb8\x8c"),        // 中
	[]byte("\xed\xa0\x80"),        // surrogate half
	[]byte("\xc0\xaf"),            // overlong '/'
	[]byte("\xf0\x9f\x98\x80"),    // emoji
	[]byte("\xfe\xffabc\xff\xfe"), // invalid prefix and suffix
	[]byte("\xffhello\xe4\xb8\x8c\xff"),
	[]byte("\xe4\xb8ab"), // truncated sequence followed by ASCII
	[]byte("abc\xf0\x9f"),
	[]byte("\x80\x80"),
	[]byte("a\xe4\xb8\x8c\xf0\x9f\x98\x80z\xff"),
}

// reference is an independent one-shot implementation used as the oracle.
func reference(src []byte) ([]byte, Mapping) {
	var out []byte
	var m Mapping
	for i := 0; i < len(src); {
		r, size := utf8.DecodeRune(src[i:])
		if r == utf8.RuneError && size == 1 {
			out = append(out, 0xEF, 0xBF, 0xBD)
			m.RuneToByte = append(m.RuneToByte, i)
			m.ByteToRune = append(m.ByteToRune, len(m.RuneToByte)-1)
			i++
			continue
		}
		out = append(out, src[i:i+size]...)
		m.RuneToByte = append(m.RuneToByte, i)
		for k := 0; k < size; k++ {
			idx := len(m.RuneToByte) - 1
			m.ByteToRune = append(m.ByteToRune, idx)
		}
		i += size
	}
	return out, m
}

// checkMapping verifies the bidirectional mapping between src and out.
func checkMapping(t *testing.T, src, out []byte, m Mapping) {
	t.Helper()
	if !utf8.Valid(out) {
		t.Fatalf("output is not valid UTF-8: %q", out)
	}
	if len(m.ByteToRune) != len(src) {
		t.Fatalf("len(ByteToRune)=%d, want %d", len(m.ByteToRune), len(src))
	}
	if len(m.RuneToByte) != utf8.RuneCount(out) {
		t.Fatalf("len(RuneToByte)=%d, want %d", len(m.RuneToByte), utf8.RuneCount(out))
	}
	j := 0
	prev := -1
	for rest := out; len(rest) > 0; j++ {
		r, size := utf8.DecodeRune(rest)
		rest = rest[size:]
		s := m.RuneToByte[j]
		e := len(src)
		if j+1 < len(m.RuneToByte) {
			e = m.RuneToByte[j+1]
		}
		if s < 0 || s > e || e > len(src) {
			t.Fatalf("rune %d: bad source span [%d,%d)", j, s, e)
		}
		seg := src[s:e]
		if string(seg) != string(r) {
			// Not a preserved valid sequence: must be exactly one invalid
			// byte replaced by one U+FFFD.
			if r != utf8.RuneError || len(seg) != 1 || utf8.Valid(seg) {
				t.Fatalf("rune %d: %q maps to source %q", j, string(r), seg)
			}
		}
		for i := s; i < e; i++ {
			if m.ByteToRune[i] != j {
				t.Fatalf("byte %d: ByteToRune=%d, want %d", i, m.ByteToRune[i], j)
			}
		}
		if s <= prev {
			t.Fatalf("RuneToByte not strictly increasing at rune %d", j)
		}
		prev = s
	}
}

func TestTable(t *testing.T) {
	cases := []struct {
		in         string
		want       string
		byteToRune []int
		runeToByte []int
	}{
		{"", "", nil, nil},
		{"abc", "abc", []int{0, 1, 2}, []int{0, 1, 2}},
		{"\xffabc", "�abc", []int{0, 1, 2, 3}, []int{0, 1, 2, 3}},
		{"abc\xff", "abc�", []int{0, 1, 2, 3}, []int{0, 1, 2, 3}},
		{"\xff\xfe", "��", []int{0, 1}, []int{0, 1}},
		{"\xe4\xb8", "��", []int{0, 1}, []int{0, 1}},
		{"\xed\xa0\x80", "���", []int{0, 1, 2}, []int{0, 1, 2}},
		{"\xc0\xaf", "��", []int{0, 1}, []int{0, 1}},
		{"\xf0\x9f", "��", []int{0, 1}, []int{0, 1}},
		{"中", "中", []int{0, 0, 0}, []int{0}},
		{"\xff中", "�中", []int{0, 1, 1, 1}, []int{0, 1}},
		{"中\xff", "中�", []int{0, 0, 0, 1}, []int{0, 3}},
		{"a中b", "a中b", []int{0, 1, 1, 1, 2}, []int{0, 1, 4}},
		{"\xf0\x9f\x98\x80", "😀", []int{0, 0, 0, 0}, []int{0}},
		{"\xe4\xb8ab", "��ab", []int{0, 1, 2, 3}, []int{0, 1, 2, 3}},
	}
	for _, c := range cases {
		out, m := Fix([]byte(c.in))
		if string(out) != c.want {
			t.Errorf("Fix(%q) = %q, want %q", c.in, out, c.want)
		}
		if !reflect.DeepEqual(m.ByteToRune, c.byteToRune) {
			t.Errorf("Fix(%q) ByteToRune = %v, want %v", c.in, m.ByteToRune, c.byteToRune)
		}
		if !reflect.DeepEqual(m.RuneToByte, c.runeToByte) {
			t.Errorf("Fix(%q) RuneToByte = %v, want %v", c.in, m.RuneToByte, c.runeToByte)
		}
		checkMapping(t, []byte(c.in), out, m)
	}
}

// compositions returns all ways to split n bytes into positive-size chunks.
func compositions(n int) [][]int {
	if n == 0 {
		return [][]int{{}}
	}
	var res [][]int
	for mask := 0; mask < 1<<(n-1); mask++ {
		var comp []int
		last := 0
		for i := 1; i < n; i++ {
			if mask&(1<<(i-1)) != 0 {
				comp = append(comp, i-last)
				last = i
			}
		}
		comp = append(comp, n-last)
		res = append(res, comp)
	}
	return res
}

func runChunked(src []byte, sizes []int) ([]byte, Mapping) {
	f := NewFixer()
	off := 0
	for _, s := range sizes {
		f.Write(src[off : off+s])
		off += s
	}
	f.Flush()
	return f.Drain(), f.Mapping()
}

// TestAllChunkings feeds every corpus input through every possible chunking
// and requires output and mapping to equal the one-shot oracle, proving
// trailing sequences are never judged prematurely across chunk boundaries.
func TestAllChunkings(t *testing.T) {
	for _, src := range corpus {
		wantOut, wantMap := reference(src)
		if len(src) > 16 {
			t.Fatalf("corpus input too long for exhaustive chunking: %d bytes", len(src))
		}
		for _, comp := range compositions(len(src)) {
			out, m := runChunked(src, comp)
			if !bytes.Equal(out, wantOut) {
				t.Fatalf("src=%q chunks=%v: out=%q, want %q", src, comp, out, wantOut)
			}
			if !reflect.DeepEqual(m, wantMap) {
				t.Fatalf("src=%q chunks=%v: map=%+v, want %+v", src, comp, m, wantMap)
			}
		}
	}
}

// TestRandomChunkings covers longer inputs with random chunk sizes.
func TestRandomChunkings(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	pool := append([]byte("hello 中文 😀 "), 0xff, 0xfe, 0x80, 0xc0, 0xed, 0xa0, 0xf0, 0x9f)
	for trial := 0; trial < 200; trial++ {
		n := rng.Intn(200)
		src := make([]byte, n)
		for i := range src {
			src[i] = pool[rng.Intn(len(pool))]
		}
		wantOut, wantMap := reference(src)
		f := NewFixer()
		for off := 0; off < len(src); {
			s := 1 + rng.Intn(7)
			if s > len(src)-off {
				s = len(src) - off
			}
			f.Write(src[off : off+s])
			off += s
		}
		f.Flush()
		out, m := f.Drain(), f.Mapping()
		if !bytes.Equal(out, wantOut) {
			t.Fatalf("trial %d src=%q: out=%q, want %q", trial, src, out, wantOut)
		}
		if !reflect.DeepEqual(m, wantMap) {
			t.Fatalf("trial %d src=%q: mapping mismatch", trial, src)
		}
		checkMapping(t, src, out, m)
	}
}

// TestCorpusMapping checks mapping invariants on the whole corpus one-shot.
func TestCorpusMapping(t *testing.T) {
	for _, src := range corpus {
		out, m := Fix(src)
		checkMapping(t, src, out, m)
	}
}
