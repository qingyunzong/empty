package stresc

import (
	"math/rand"
	"strings"
	"testing"
)

func TestDecodeBasic(t *testing.T) {
	cases := []struct {
		src, want string
	}{
		{"hello", "hello"},
		{"", ""},
		{`\x41\x42\x43`, "ABC"},
		{`\x41B\x43`, "ABC"},
		{`A`, "A"},
		{`😀`, "😀"},
		{`\uD83D\uDE00`, "😀"}, // surrogate pair
		{`\uD83D\uDE00x`, "😀x"},
		{`a\uD83D\uDE00b`, "a😀b"},
		{`\\`, `\`},
		{"\n\t\r", "\n\t\r"},
		{`a\\b`, `a\b`},
		{`\xe9`, "é"},
		{`\xE9`, "é"},        // uppercase hex digits
		{"héllo😀", "héllo😀"}, // literal UTF-8 passthrough
	}
	for _, c := range cases {
		got, err := Decode(c.src)
		if err != nil {
			t.Errorf("Decode(%q) error: %v", c.src, err)
			continue
		}
		if got != c.want {
			t.Errorf("Decode(%q) = %q, want %q", c.src, got, c.want)
		}
	}
}

func TestDecodeErrorSpans(t *testing.T) {
	cases := []struct {
		src      string
		msgSub   string
		wantSpan Span
	}{
		{`\x4`, "truncated", Span{0, 3}},
		{`\x`, "truncated", Span{0, 2}},
		{`\xZZ`, "invalid hex escape", Span{0, 4}},
		{`ab\xZZ`, "invalid hex escape", Span{2, 6}},
		{`\u12`, "truncated", Span{0, 4}},
		{`\u12ZZ`, "invalid unicode escape", Span{0, 6}},
		{`\uD83D`, "truncated", Span{0, 6}},                      // lone high surrogate at EOF
		{`\uD83Dx`, "unpaired high surrogate", Span{0, 6}},       // not followed by \u
		{`\uD83D\u0041`, "unpaired high surrogate", Span{0, 12}}, // paired with non-surrogate
		{`\uD83D\uD83D`, "unpaired high surrogate", Span{0, 12}}, // two highs
		{`\uD83D\uZZZZ`, "invalid unicode escape", Span{6, 12}},  // bad hex in low half
		{`\uDE00`, "unpaired low surrogate", Span{0, 6}},         // lone low surrogate
		{`xy\uDE00`, "unpaired low surrogate", Span{2, 8}},
		{`\U00110000`, "invalid code point", Span{0, 10}}, // > MaxRune
		{`\U0000D800`, "invalid code point", Span{0, 10}}, // surrogate via \U
		{`\U0001F600`, "", Span{}},                        // valid, no error
		{`\q`, "unknown escape", Span{0, 2}},
		{`abc\q`, "unknown escape", Span{3, 5}},
		{`abc\`, "truncated", Span{3, 4}},
	}
	for _, c := range cases {
		_, err := Decode(c.src)
		if c.msgSub == "" {
			if err != nil {
				t.Errorf("Decode(%q) unexpected error: %v", c.src, err)
			}
			continue
		}
		if err == nil {
			t.Errorf("Decode(%q) expected error containing %q", c.src, c.msgSub)
			continue
		}
		derr, ok := err.(*Error)
		if !ok {
			t.Fatalf("Decode(%q) error type %T, want *Error", c.src, err)
		}
		if !strings.Contains(derr.Msg, c.msgSub) {
			t.Errorf("Decode(%q) msg = %q, want substring %q", c.src, derr.Msg, c.msgSub)
		}
		if derr.Span != c.wantSpan {
			t.Errorf("Decode(%q) span = %v, want %v", c.src, derr.Span, c.wantSpan)
		}
		// The span must reference exactly the offending source segment.
		if derr.Span.Start < 0 || derr.Span.End > len(c.src) || derr.Span.Start >= derr.Span.End {
			t.Errorf("Decode(%q) span %v out of range", c.src, derr.Span)
		}
	}
}

func TestSourceMapLookup(t *testing.T) {
	src := `A\x42\u0043\uD83D\uDE00`
	want := "ABC😀"
	got, m, err := DecodeWithMap(src)
	if err != nil {
		t.Fatalf("DecodeWithMap(%q): %v", src, err)
	}
	if got != want {
		t.Fatalf("DecodeWithMap(%q) = %q, want %q", src, got, want)
	}
	wantSpans := []Span{
		{0, 1},   // A
		{1, 5},   // \x42
		{5, 11},  // C
		{11, 23}, // 😀 surrogate pair escape
	}
	if m.Len() != len(wantSpans) {
		t.Fatalf("map len = %d, want %d", m.Len(), len(wantSpans))
	}
	for i, sp := range wantSpans {
		if got := m.Lookup(i); got != sp {
			t.Errorf("Lookup(%d) = %v, want %v", i, got, sp)
		}
		// Each mapped segment must decode back to the same rune.
		seg := src[sp.Start:sp.End]
		r, derr := Decode(seg)
		if derr != nil || r != string([]rune(want)[i]) {
			t.Errorf("segment %q decodes to %q (err %v), want rune %q",
				seg, r, derr, []rune(want)[i])
		}
	}
}

func TestSourceMapLiteralUTF8(t *testing.T) {
	src := "é😀x"
	_, m, err := DecodeWithMap(src)
	if err != nil {
		t.Fatal(err)
	}
	want := []Span{{0, 2}, {2, 6}, {6, 7}}
	for i, sp := range want {
		if got := m.Lookup(i); got != sp {
			t.Errorf("Lookup(%d) = %v, want %v", i, got, sp)
		}
	}
}

func TestEncodeRoundTrip(t *testing.T) {
	samples := []string{
		"",
		"plain ascii",
		"tab\tnewline\ncr\rbackslash\\",
		"control \x00\x1f\x7f chars",
		"héllo wörld",
		"emoji 😀🎉 and CJK 你好",
		"mixed \\x41 not-an-escape",
		"\U0001F600\uFFFD边缘",
	}
	opts := []Options{
		{},
		{EscapeNonASCII: true},
		{EscapeAll: true},
	}
	for _, s := range samples {
		for _, o := range opts {
			enc := Encode(s, o)
			dec, m, err := DecodeWithMap(enc)
			if err != nil {
				t.Errorf("Decode(Encode(%q)) error: %v (enc=%q)", s, err, enc)
				continue
			}
			if dec != s {
				t.Errorf("round trip failed: %q -> %q -> %q", s, enc, dec)
				continue
			}
			checkMapAgainstSource(t, s, enc, m)
		}
	}
}

// checkMapAgainstSource verifies that the source map of the decoded
// round trip maps every rune of the original string to a segment of the
// encoded string that decodes to exactly that rune.
func checkMapAgainstSource(t *testing.T, orig, enc string, m *SourceMap) {
	t.Helper()
	runes := []rune(orig)
	if m.Len() != len(runes) {
		t.Fatalf("map len %d != rune count %d for %q", m.Len(), len(runes), orig)
	}
	for i, r := range runes {
		sp := m.Lookup(i)
		if sp.Start < 0 || sp.End > len(enc) || sp.Start >= sp.End {
			t.Fatalf("rune %d: span %v out of range for %q", i, sp, enc)
		}
		seg := enc[sp.Start:sp.End]
		dec, err := Decode(seg)
		if err != nil {
			t.Fatalf("rune %d: segment %q fails to decode: %v", i, seg, err)
		}
		if dec != string(r) {
			t.Fatalf("rune %d: segment %q decodes to %q, want %q", i, seg, dec, string(r))
		}
	}
}

func TestEncodeRoundTripRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for iter := 0; iter < 500; iter++ {
		n := rng.Intn(20)
		rs := make([]rune, n)
		for i := range rs {
			switch rng.Intn(4) {
			case 0:
				rs[i] = rune(rng.Intn(0x80)) // ASCII incl. controls & backslash
			case 1:
				rs[i] = rune(0x80 + rng.Intn(0x780))
			case 2:
				rs[i] = rune(0x800 + rng.Intn(0xD7FF-0x800))
			default:
				rs[i] = rune(0xE000 + rng.Intn(0x110000-0xE000))
			}
		}
		s := string(rs)
		for _, o := range []Options{{}, {EscapeNonASCII: true}, {EscapeAll: true}} {
			enc := Encode(s, o)
			dec, m, err := DecodeWithMap(enc)
			if err != nil {
				t.Fatalf("iter %d: Decode(Encode(%q)) error: %v", iter, s, err)
			}
			if dec != s {
				t.Fatalf("iter %d: round trip %q -> %q -> %q", iter, s, enc, dec)
			}
			checkMapAgainstSource(t, s, enc, m)
		}
	}
}
