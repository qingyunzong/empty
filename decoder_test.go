package textstream

import (
	"math/rand"
	"slices"
	"testing"
	"unicode/utf8"
)

// decodeChunked feeds data to a fresh Decoder, splitting at the given byte
// offsets, then closes it.
func decodeChunked(data []byte, splits ...int) ([]rune, []Mapping) {
	d := NewDecoder()
	prev := 0
	for _, s := range splits {
		d.Write(data[prev:s])
		prev = s
	}
	d.Write(data[prev:])
	d.Close()
	return d.Runes(), d.Mappings()
}

// referenceDecode is the independent oracle: stdlib semantics on a
// complete input (invalid encodings consume one byte each).
func referenceDecode(data []byte) []rune {
	var out []rune
	for len(data) > 0 {
		r, size := utf8.DecodeRune(data)
		out = append(out, r)
		data = data[size:]
	}
	return out
}

func checkContiguous(t *testing.T, maps []Mapping, total int) {
	t.Helper()
	pos := 0
	for _, m := range maps {
		if m.Start != pos || m.End <= m.Start {
			t.Fatalf("non-contiguous mapping %+v at output offset %d", m, pos)
		}
		pos = m.End
	}
	if pos != total {
		t.Fatalf("mappings end at %d, want %d", pos, total)
	}
}

// TestAllTwoByteSequences exhaustively decodes every 2-byte input, whole
// and split across the chunk boundary, and checks it against the stdlib
// oracle and the mapping invariants.
func TestAllTwoByteSequences(t *testing.T) {
	for b0 := 0; b0 < 256; b0++ {
		for b1 := 0; b1 < 256; b1++ {
			data := []byte{byte(b0), byte(b1)}
			want := referenceDecode(data)

			wholeR, wholeM := DecodeAll(data)
			if !slices.Equal(wholeR, want) {
				t.Fatalf("DecodeAll(% x) = %U, want %U", data, wholeR, want)
			}
			checkContiguous(t, wholeM, 2)

			splitR, splitM := decodeChunked(data, 1)
			if !slices.Equal(splitR, want) || !slices.Equal(splitM, wholeM) {
				t.Fatalf("chunked decode of % x = %U %+v, want %U %+v", data, splitR, splitM, want, wholeM)
			}
		}
	}
}

// TestFourByteSplits checks representative 4-byte (and related) sequences
// under every possible chunk split against hand-computed expectations.
func TestFourByteSplits(t *testing.T) {
	const FFFD = utf8.RuneError
	cases := []struct {
		name string
		seq  []byte
		want []rune
	}{
		{"min-4byte", []byte{0xF0, 0x90, 0x80, 0x80}, []rune{0x10000}},
		{"emoji", []byte{0xF0, 0x9F, 0x98, 0x80}, []rune{0x1F600}},
		{"max-4byte", []byte{0xF4, 0x8F, 0xBF, 0xBF}, []rune{0x10FFFF}},
		{"overlong-4byte", []byte{0xF0, 0x80, 0x80, 0x80}, []rune{FFFD, FFFD, FFFD, FFFD}},
		{"above-max", []byte{0xF4, 0x90, 0x80, 0x80}, []rune{FFFD, FFFD, FFFD, FFFD}},
		{"invalid-lead", []byte{0xF5, 0x80, 0x80, 0x80}, []rune{FFFD, FFFD, FFFD, FFFD}},
		{"truncated", []byte{0xF0, 0x9F, 0x98}, []rune{FFFD, FFFD, FFFD}},
		{"bad-continuation", []byte{0xF0, 0x9F, 0x41, 0x80}, []rune{FFFD, FFFD, 'A', FFFD}},
		{"cesu-surrogate", []byte{0xED, 0xA0, 0x80}, []rune{FFFD, FFFD, FFFD}},
		{"overlong-3byte", []byte{0xE0, 0x80, 0x80}, []rune{FFFD, FFFD, FFFD}},
		{"min-3byte", []byte{0xE0, 0xA0, 0x80}, []rune{0x800}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wholeR, wholeM := DecodeAll(tc.seq)
			if !slices.Equal(wholeR, tc.want) {
				t.Fatalf("DecodeAll(% x) = %U, want %U", tc.seq, wholeR, tc.want)
			}
			checkContiguous(t, wholeM, len(tc.seq))
			// Enumerate every subset of split points between bytes.
			n := len(tc.seq)
			for mask := 0; mask < 1<<(n-1); mask++ {
				var splits []int
				for i := 1; i < n; i++ {
					if mask&(1<<(i-1)) != 0 {
						splits = append(splits, i)
					}
				}
				gotR, gotM := decodeChunked(tc.seq, splits...)
				if !slices.Equal(gotR, tc.want) || !slices.Equal(gotM, wholeM) {
					t.Fatalf("decode of % x with splits %v = %U %+v, want %U %+v",
						tc.seq, splits, gotR, gotM, tc.want, wholeM)
				}
			}
		})
	}
}

// TestShortestForm pins the exact acceptance boundaries of shortest-form
// UTF-8.
func TestShortestForm(t *testing.T) {
	const FFFD = utf8.RuneError
	cases := []struct {
		seq  []byte
		want []rune
	}{
		{[]byte{0x41}, []rune{'A'}},
		{[]byte{0x7F}, []rune{0x7F}},
		{[]byte{0xC0, 0x80}, []rune{FFFD, FFFD}},             // overlong NUL
		{[]byte{0xC1, 0xBF}, []rune{FFFD, FFFD}},             // overlong 0x7F
		{[]byte{0xC2, 0x80}, []rune{0x80}},                   // smallest 2-byte
		{[]byte{0xDF, 0xBF}, []rune{0x7FF}},                  // largest 2-byte
		{[]byte{0xE0, 0x9F, 0xBF}, []rune{FFFD, FFFD, FFFD}}, // overlong 3-byte
		{[]byte{0xE0, 0xA0, 0x80}, []rune{0x800}},            // smallest 3-byte
		{[]byte{0xED, 0x9F, 0xBF}, []rune{0xD7FF}},           // below surrogates
		{[]byte{0xED, 0xA0, 0x80}, []rune{FFFD, FFFD, FFFD}}, // surrogate U+D800
		{[]byte{0xED, 0xBF, 0xBF}, []rune{FFFD, FFFD, FFFD}}, // surrogate U+DFFF
		{[]byte{0xEE, 0x80, 0x80}, []rune{0xE000}},           // above surrogates
		{[]byte{0xEF, 0xBF, 0xBF}, []rune{0xFFFF}},
		{[]byte{0xEF, 0xBF, 0xBD}, []rune{0xFFFD}}, // genuine U+FFFD is valid
	}
	for _, tc := range cases {
		got, maps := DecodeAll(tc.seq)
		if !slices.Equal(got, tc.want) {
			t.Fatalf("DecodeAll(% x) = %U, want %U", tc.seq, got, tc.want)
		}
		checkContiguous(t, maps, len(tc.seq))
	}
}

// TestRandomBytesMatchStdlib fuzzes DecodeAll against the stdlib oracle.
func TestRandomBytesMatchStdlib(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	pool := []byte{0x41, 0x7F, 0x80, 0xBF, 0xC0, 0xC2, 0xDF, 0xE0, 0xE4, 0xED, 0xEF, 0xF0, 0xF4, 0xF5, 0xFF, 0x9F, 0xA0, 0x90}
	for iter := 0; iter < 20000; iter++ {
		n := rng.Intn(12)
		data := make([]byte, n)
		for i := range data {
			data[i] = pool[rng.Intn(len(pool))]
		}
		got, maps := DecodeAll(data)
		if want := referenceDecode(data); !slices.Equal(got, want) {
			t.Fatalf("DecodeAll(% x) = %U, want %U", data, got, want)
		}
		checkContiguous(t, maps, n)
		// Random chunking must not change the result.
		var splits []int
		for i := 1; i < n; i++ {
			if rng.Intn(2) == 0 {
				splits = append(splits, i)
			}
		}
		gotR, gotM := decodeChunked(data, splits...)
		if !slices.Equal(gotR, got) || !slices.Equal(gotM, maps) {
			t.Fatalf("chunked decode of % x (splits %v) differs", data, splits)
		}
	}
}

// TestTrailingIncompleteWaits verifies that a truncated sequence is held
// back across chunk boundaries.
func TestTrailingIncompleteWaits(t *testing.T) {
	d := NewDecoder()
	d.Write([]byte{0xF0, 0x9F})
	if d.Len() != 0 {
		t.Fatalf("decoder emitted %d code points for an incomplete sequence", d.Len())
	}
	d.Write([]byte{0x98, 0x80})
	if d.Len() != 1 {
		t.Fatalf("decoder emitted %d code points, want 1", d.Len())
	}
	d.Close()
	runes, maps := d.Runes(), d.Mappings()
	if runes[0] != 0x1F600 || maps[0] != (Mapping{Start: 0, End: 4}) {
		t.Fatalf("got %U %+v, want U+1F600 [{0 4}]", runes, maps)
	}
}

// TestCloseFlushesPerByte verifies the final flush consumes one byte per
// replacement character.
func TestCloseFlushesPerByte(t *testing.T) {
	runes, maps := DecodeAll([]byte{0xE0, 0xA0})
	if !slices.Equal(runes, []rune{utf8.RuneError, utf8.RuneError}) {
		t.Fatalf("got %U, want two U+FFFD", runes)
	}
	if !slices.Equal(maps, []Mapping{{0, 1}, {1, 2}}) {
		t.Fatalf("got maps %+v", maps)
	}
}

// TestMappingOffsets checks exact byte ranges on mixed content.
func TestMappingOffsets(t *testing.T) {
	data := []byte("aé水\U0001F600\x80")
	_, maps := DecodeAll(data)
	want := []Mapping{{0, 1}, {1, 3}, {3, 6}, {6, 10}, {10, 11}}
	if !slices.Equal(maps, want) {
		t.Fatalf("got %+v, want %+v", maps, want)
	}
}
