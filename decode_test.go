package streamtext

import (
	"slices"
	"testing"
	"unicode/utf8"
)

func decodeViaChunks(chunks ...[]byte) ([]rune, []Span) {
	d := NewDecoder()
	var runes []rune
	var spans []Span
	for _, c := range chunks {
		r, s := d.Write(c)
		runes = append(runes, r...)
		spans = append(spans, s...)
	}
	r, s := d.Flush()
	return append(runes, r...), append(spans, s...)
}

func checkSplit(t *testing.T, data []byte, split int) {
	t.Helper()
	wantR, wantS := Decode(data)
	gotR, gotS := decodeViaChunks(data[:split], data[split:])
	if !slices.Equal(gotR, wantR) || !slices.Equal(gotS, wantS) {
		t.Fatalf("data % x split %d: got (%U, %v), want (%U, %v)",
			data, split, gotR, gotS, wantR, wantS)
	}
}

// TestAllBytePairsSplit decodes every possible two-byte input in one shot
// and split across two chunks, and requires identical results.
func TestAllBytePairsSplit(t *testing.T) {
	for b1 := 0; b1 < 256; b1++ {
		for b2 := 0; b2 < 256; b2++ {
			data := []byte{byte(b1), byte(b2)}
			wantR, wantS := Decode(data)
			gotR, gotS := decodeViaChunks(data[:1], data[1:])
			if !slices.Equal(gotR, wantR) || !slices.Equal(gotS, wantS) {
				t.Fatalf("pair % x: split got (%U, %v), want (%U, %v)",
					data, gotR, gotS, wantR, wantS)
			}
		}
	}
}

// TestValidTwoByteExhaustive checks every valid two-byte sequence decodes
// to the same code point as unicode/utf8, with span [0,2), and that the
// lead byte alone is held back while streaming.
func TestValidTwoByteExhaustive(t *testing.T) {
	for lead := 0xC2; lead <= 0xDF; lead++ {
		for cont := 0x80; cont <= 0xBF; cont++ {
			data := []byte{byte(lead), byte(cont)}
			runes, spans := Decode(data)
			want, size := utf8.DecodeRune(data)
			if size != 2 || len(runes) != 1 || runes[0] != want {
				t.Fatalf("% x: got %U, want %U", data, runes, want)
			}
			if spans[0] != (Span{0, 2}) {
				t.Fatalf("% x: span %v, want [0 2]", data, spans[0])
			}
			d := NewDecoder()
			r, _ := d.Write(data[:1])
			if len(r) != 0 || !d.Pending() {
				t.Fatalf("% x: lead byte not held", data)
			}
			r, s := d.Write(data[1:])
			if len(r) != 1 || r[0] != want || s[0] != (Span{0, 2}) {
				t.Fatalf("% x: after cont got (%U, %v)", data, r, s)
			}
		}
	}
}

// TestFourByteSplits checks key four-byte sequences (boundary and astral
// code points) split at every position.
func TestFourByteSplits(t *testing.T) {
	var enc [4]byte
	for _, r := range []rune{0x10000, 0x10FFFF, 0x1F600, 0x20000, 0x40000, 0xFFFF0} {
		n := utf8.EncodeRune(enc[:], r)
		data := enc[:n]
		runes, spans := Decode(data)
		if len(runes) != 1 || runes[0] != r || spans[0] != (Span{0, 4}) {
			t.Fatalf("%U % x: got (%U, %v)", r, data, runes, spans)
		}
		for split := 1; split < 4; split++ {
			checkSplit(t, data, split)
		}
	}
}

// TestInvalidSequences checks the one-byte-at-a-time replacement rule and
// shortest-form rejection, one-shot and at every split.
func TestInvalidSequences(t *testing.T) {
	cases := []struct {
		data  []byte
		runes []rune
		spans []Span
	}{
		{[]byte{0xC0, 0x80}, []rune{Replacement, Replacement}, []Span{{0, 1}, {1, 2}}},                                                       // overlong NUL
		{[]byte{0xC1, 0xBF}, []rune{Replacement, Replacement}, []Span{{0, 1}, {1, 2}}},                                                       // overlong
		{[]byte{0xE0, 0x80, 0x80}, []rune{Replacement, Replacement, Replacement}, []Span{{0, 1}, {1, 2}, {2, 3}}},                            // overlong 3-byte
		{[]byte{0xE0, 0x9F, 0x80}, []rune{Replacement, Replacement, Replacement}, []Span{{0, 1}, {1, 2}, {2, 3}}},                            // below E0 floor
		{[]byte{0xED, 0xA0, 0x80}, []rune{Replacement, Replacement, Replacement}, []Span{{0, 1}, {1, 2}, {2, 3}}},                            // surrogate U+D800
		{[]byte{0xED, 0xBF, 0xBF}, []rune{Replacement, Replacement, Replacement}, []Span{{0, 1}, {1, 2}, {2, 3}}},                            // surrogate U+DFFF
		{[]byte{0xF0, 0x8F, 0x80, 0x80}, []rune{Replacement, Replacement, Replacement, Replacement}, []Span{{0, 1}, {1, 2}, {2, 3}, {3, 4}}}, // overlong 4-byte
		{[]byte{0xF4, 0x90, 0x80, 0x80}, []rune{Replacement, Replacement, Replacement, Replacement}, []Span{{0, 1}, {1, 2}, {2, 3}, {3, 4}}}, // > U+10FFFF
		{[]byte{0xF5, 0x80, 0x80, 0x80}, []rune{Replacement, Replacement, Replacement, Replacement}, []Span{{0, 1}, {1, 2}, {2, 3}, {3, 4}}}, // bad lead
		{[]byte{0xFF, 0xFE}, []rune{Replacement, Replacement}, []Span{{0, 1}, {1, 2}}},
		{[]byte{0x80}, []rune{Replacement}, []Span{{0, 1}}}, // lone continuation
		{[]byte{0xE4, 0xB8, 'A'}, []rune{Replacement, Replacement, 'A'}, []Span{{0, 1}, {1, 2}, {2, 3}}},
		{[]byte{0xF0, 0x90, 0x41, 0x80}, []rune{Replacement, Replacement, 'A', Replacement}, []Span{{0, 1}, {1, 2}, {2, 3}, {3, 4}}},
		{[]byte{0xE4, 0xB8}, []rune{Replacement, Replacement}, []Span{{0, 1}, {1, 2}}},                            // truncated at EOF
		{[]byte{0xF0, 0x90, 0x80}, []rune{Replacement, Replacement, Replacement}, []Span{{0, 1}, {1, 2}, {2, 3}}}, // truncated at EOF
	}
	for _, tc := range cases {
		runes, spans := Decode(tc.data)
		if !slices.Equal(runes, tc.runes) || !slices.Equal(spans, tc.spans) {
			t.Errorf("% x: got (%U, %v), want (%U, %v)", tc.data, runes, spans, tc.runes, tc.spans)
		}
		for split := 1; split < len(tc.data); split++ {
			checkSplit(t, tc.data, split)
		}
	}
}

// TestTrailingIncompleteWaits verifies a truncated sequence at a chunk
// boundary produces nothing until the next chunk completes it.
func TestTrailingIncompleteWaits(t *testing.T) {
	d := NewDecoder()
	runes, spans := d.Write([]byte{'a', 'b', 0xE4, 0xB8})
	if !slices.Equal(runes, []rune{'a', 'b'}) || !slices.Equal(spans, []Span{{0, 1}, {1, 2}}) {
		t.Fatalf("first chunk: (%U, %v)", runes, spans)
	}
	if !d.Pending() {
		t.Fatal("expected pending bytes")
	}
	runes, spans = d.Write([]byte{0xAD, 'c'})
	if !slices.Equal(runes, []rune{'\u4e2d', 'c'}) || !slices.Equal(spans, []Span{{2, 5}, {5, 6}}) {
		t.Fatalf("second chunk: (%U, %v)", runes, spans)
	}
	if r, _ := d.Flush(); len(r) != 0 {
		t.Fatalf("flush: %U", r)
	}
}

// TestMappingCoversInput checks spans are contiguous, ordered, cover the
// whole input, and that valid code points re-decode from their byte range.
func TestMappingCoversInput(t *testing.T) {
	data := []byte("a\xE4\xB8\x8D\xFF\xF0\x9F\x98\x80z\xC2\xA2\x80")
	runes, spans := Decode(data)
	if len(runes) != len(spans) {
		t.Fatalf("runes/spans length mismatch")
	}
	pos := 0
	for i, s := range spans {
		if s.Start != pos || s.End <= s.Start {
			t.Fatalf("span %d = %v, want start %d", i, s, pos)
		}
		pos = s.End
		if runes[i] != Replacement {
			r, size := utf8.DecodeRune(data[s.Start:s.End])
			if r != runes[i] || size != s.End-s.Start {
				t.Fatalf("span %d: bytes re-decode to %U/%d, want %U", i, r, size, runes[i])
			}
		}
	}
	if pos != len(data) {
		t.Fatalf("spans end at %d, input len %d", pos, len(data))
	}
}

// TestDecoderOffset verifies absolute offsets with NewDecoderAt.
func TestDecoderOffset(t *testing.T) {
	d := NewDecoderAt(100)
	runes, spans := d.Write([]byte("x\xC3"))
	r, s := d.Write([]byte{0xA9})
	runes = append(runes, r...)
	spans = append(spans, s...)
	wantSpans := []Span{{100, 101}, {101, 103}}
	if !slices.Equal(runes, []rune{'x', 'é'}) || !slices.Equal(spans, wantSpans) {
		t.Fatalf("got (%U, %v)", runes, spans)
	}
}
