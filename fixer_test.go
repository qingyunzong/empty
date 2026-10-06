package utf8fix

import (
	"bytes"
	"reflect"
	"testing"
	"unicode/utf8"
)

// TestFixTable pins exact output and mapping for representative inputs,
// including invalid prefixes/suffixes and truncated sequences.
func TestFixTable(t *testing.T) {
	cases := []struct {
		name    string
		src     string
		wantOut string
		wantMap Mapping
	}{
		{"empty", "", "", Mapping{}},
		{"ascii", "abc", "abc", Mapping{CPToByte: []int{0, 1, 2}, ByteToCP: []int{0, 1, 2}}},
		{"valid multibyte kept", "a中b", "a中b",
			Mapping{CPToByte: []int{0, 1, 4}, ByteToCP: []int{0, 1, 1, 1, 2}}},
		{"single invalid byte", "\xff", Replacement,
			Mapping{CPToByte: []int{0}, ByteToCP: []int{0}}},
		{"invalid prefix", "\xffab", Replacement + "ab",
			Mapping{CPToByte: []int{0, 1, 2}, ByteToCP: []int{0, 1, 2}}},
		{"invalid suffix", "ab\xff", "ab" + Replacement,
			Mapping{CPToByte: []int{0, 1, 2}, ByteToCP: []int{0, 1, 2}}},
		{"each invalid byte one replacement", "\xff\xfe", Replacement + Replacement,
			Mapping{CPToByte: []int{0, 1}, ByteToCP: []int{0, 1}}},
		{"truncated 3-byte at EOF", "\xe4\xb8", Replacement + Replacement,
			Mapping{CPToByte: []int{0, 1}, ByteToCP: []int{0, 1}}},
		{"truncated 4-byte at EOF", "\xf0\x9f\x98", Replacement + Replacement + Replacement,
			Mapping{CPToByte: []int{0, 1, 2}, ByteToCP: []int{0, 1, 2}}},
		{"lone continuation", "\x80", Replacement,
			Mapping{CPToByte: []int{0}, ByteToCP: []int{0}}},
		{"bad continuation restarts", "\xc2A", Replacement + "A",
			Mapping{CPToByte: []int{0, 1}, ByteToCP: []int{0, 1}}},
		{"surrogate encoded", "a\xed\xa0\x80b", "a" + Replacement + Replacement + Replacement + "b",
			Mapping{CPToByte: []int{0, 1, 2, 3, 4}, ByteToCP: []int{0, 1, 2, 3, 4}}},
		{"valid between truncated", "中\xe4\xb8文", "中" + Replacement + Replacement + "文",
			Mapping{CPToByte: []int{0, 3, 4, 5}, ByteToCP: []int{0, 0, 0, 1, 2, 3, 3, 3}}},
		{"mixed", "a\xff中", "a" + Replacement + "中",
			Mapping{CPToByte: []int{0, 1, 2}, ByteToCP: []int{0, 1, 2, 2, 2}}},
		{"real U+FFFD kept as-is", "\xef\xbf\xbd", "\xef\xbf\xbd",
			Mapping{CPToByte: []int{0}, ByteToCP: []int{0, 0, 0}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, m := Fix([]byte(c.src))
			if string(out) != c.wantOut {
				t.Fatalf("out = %q, want %q", out, c.wantOut)
			}
			if !reflect.DeepEqual(m, c.wantMap) {
				t.Fatalf("mapping = %+v, want %+v", m, c.wantMap)
			}
			verifyMapping(t, []byte(c.src), out, m)
		})
	}
}

// verifyMapping checks the bidirectional invariants of m against src and out.
func verifyMapping(t *testing.T, src, out []byte, m Mapping) {
	t.Helper()
	if !utf8.Valid(out) {
		t.Fatalf("output %q is not valid UTF-8", out)
	}
	if got, want := len(m.CPToByte), utf8.RuneCount(out); got != want {
		t.Fatalf("len(CPToByte) = %d, want %d (runes in %q)", got, want, out)
	}
	if got, want := len(m.ByteToCP), len(src); got != want {
		t.Fatalf("len(ByteToCP) = %d, want %d (bytes in %q)", got, want, src)
	}
	// CPToByte is strictly increasing and lands on rune starts in src.
	for cp, off := range m.CPToByte {
		if cp > 0 && off <= m.CPToByte[cp-1] {
			t.Fatalf("CPToByte not increasing at %d: %v", cp, m.CPToByte)
		}
		if off < 0 || off >= len(src) {
			t.Fatalf("CPToByte[%d] = %d out of range [0,%d)", cp, off, len(src))
		}
		// Back-mapping: the byte a code point starts at maps back to it.
		if m.ByteToCP[off] != cp {
			t.Fatalf("ByteToCP[CPToByte[%d]=%d] = %d, want %d", cp, off, m.ByteToCP[off], cp)
		}
	}
	// ByteToCP: every byte is covered by its code point's span, and the
	// output rune matches either the source rune or one U+FFFD per bad byte.
	outRunes := []rune(string(out))
	for j, cp := range m.ByteToCP {
		start := m.CPToByte[cp]
		if start > j {
			t.Fatalf("byte %d maps to cp %d starting after it at %d", j, cp, start)
		}
		end := len(src)
		if cp+1 < len(m.CPToByte) {
			end = m.CPToByte[cp+1]
		}
		if j >= end {
			t.Fatalf("byte %d outside span [%d,%d) of cp %d", j, start, end, cp)
		}
		srcRune, size := utf8.DecodeRune(src[start:end])
		if srcRune == utf8.RuneError && size == 1 {
			if outRunes[cp] != '\uFFFD' {
				t.Fatalf("invalid src byte %d -> cp %d = %q, want U+FFFD", start, cp, outRunes[cp])
			}
		} else if outRunes[cp] != srcRune {
			t.Fatalf("valid src rune %q at %d -> cp %d = %q", srcRune, start, cp, outRunes[cp])
		}
	}
}

// runChunked feeds src through a Fixer split at the given cut mask.
func runChunked(src []byte, mask uint64) ([]byte, Mapping) {
	f := New()
	start := 0
	for i := 0; i+1 < len(src); i++ {
		if mask&(1<<uint(i)) != 0 {
			f.Write(src[start : i+1])
			start = i + 1
		}
	}
	f.Write(src[start:])
	f.Close()
	return f.Bytes(), f.Mapping()
}

// TestAllChunkings enumerates every chunking of inputs containing valid
// multi-byte runs plus invalid prefixes/infixes/suffixes, and requires the
// output and the full mapping to be identical to the one-shot result.
func TestAllChunkings(t *testing.T) {
	inputs := []string{
		"\xff",
		"a\xff",
		"\xffa",
		"中",
		"\xe4\xb8",
		"\xf0\x9f\x98",
		"a中b",
		"\xffab\xff",
		"a\xe4\xb8b",
		"中\xe4\xb8文",
		"\xc2A\x80z",
		"x\xf0\x9f\x98\x80y\xffz",
		"\xed\xa0\x80Q",
	}
	for _, src := range inputs {
		t.Run("", func(t *testing.T) {
			wantOut, wantMap := Fix([]byte(src))
			for mask := uint64(0); mask < 1<<uint(max(len(src)-1, 0)); mask++ {
				out, m := runChunked([]byte(src), mask)
				if !bytes.Equal(out, wantOut) {
					t.Fatalf("src %q mask %b: out = %q, want %q", src, mask, out, wantOut)
				}
				if !reflect.DeepEqual(m, wantMap) {
					t.Fatalf("src %q mask %b: mapping = %+v, want %+v", src, mask, m, wantMap)
				}
			}
		})
	}
}

// TestInvalidAffixes enumerates invalid prefixes and suffixes (every byte
// 0x80-0xFF plus truncated multi-byte prefixes) around a valid core and
// checks output and mapping, across chunkings of the affix boundary.
func TestInvalidAffixes(t *testing.T) {
	core := "A中B"
	prefixes := []string{""}
	suffixes := []string{""}
	for b := 0x80; b <= 0xFF; b++ { // raw invalid bytes, not rune encodings
		prefixes = append(prefixes, string([]byte{byte(b)}))
		suffixes = append(suffixes, string([]byte{byte(b)}))
	}
	for _, p := range []string{"\xe4", "\xe4\xb8", "\xf0", "\xf0\x9f", "\xf0\x9f\x98", "\xed\xa0"} {
		prefixes = append(prefixes, p)
		suffixes = append(suffixes, p)
	}
	for _, pre := range prefixes {
		for _, suf := range suffixes {
			src := []byte(pre + core + suf)
			wantOut, wantMap := Fix(src)
			// Cut at every single boundary plus every affix/core boundary pair.
			for cut := 0; cut <= len(src); cut++ {
				f := New()
				f.Write(src[:cut])
				f.Write(src[cut:])
				f.Close()
				if !bytes.Equal(f.Bytes(), wantOut) {
					t.Fatalf("src %q cut %d: out = %q, want %q", src, cut, f.Bytes(), wantOut)
				}
				if !reflect.DeepEqual(f.Mapping(), wantMap) {
					t.Fatalf("src %q cut %d: mapping = %+v, want %+v", src, cut, f.Mapping(), wantMap)
				}
			}
			verifyMapping(t, src, wantOut, wantMap)
		}
	}
}

// TestByteAtATime feeds every input one byte per Write: the extreme chunking.
func TestByteAtATime(t *testing.T) {
	inputs := []string{
		"hello, 世界 🌍",
		"\xff\xfe中\xe4\xb8文\xf0\x9f\x98\x80",
		"\xed\xa0\x80\xed\xbf\xbf",
	}
	for _, src := range inputs {
		wantOut, wantMap := Fix([]byte(src))
		f := New()
		for i := 0; i < len(src); i++ {
			f.Write([]byte{src[i]})
		}
		f.Close()
		if !bytes.Equal(f.Bytes(), wantOut) {
			t.Fatalf("src %q: out = %q, want %q", src, f.Bytes(), wantOut)
		}
		if !reflect.DeepEqual(f.Mapping(), wantMap) {
			t.Fatalf("src %q: mapping = %+v, want %+v", src, f.Mapping(), wantMap)
		}
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
