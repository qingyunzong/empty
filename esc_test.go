package esc

import (
	"errors"
	"math/rand"
	"strings"
	"testing"
)

func TestDecodeBasic(t *testing.T) {
	src := `a\x41Bé\U0001F600`
	res, err := Decode(src)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if want := "aABé\U0001F600"; res.Text != want {
		t.Fatalf("Text = %q, want %q", res.Text, want)
	}
	want := []Span{{0, 1}, {1, 5}, {5, 6}, {6, 8}, {8, 18}}
	if len(res.Spans) != len(want) {
		t.Fatalf("Spans = %v, want %v", res.Spans, want)
	}
	for i, sp := range res.Spans {
		if sp != want[i] {
			t.Errorf("Spans[%d] = %v, want %v", i, sp, want[i])
		}
	}
	if got := res.RuneSpan(4); got != (Span{8, 18}) {
		t.Errorf("RuneSpan(4) = %v", got)
	}
}

func TestDecodeSimpleEscapes(t *testing.T) {
	res, err := Decode(`\\x\n\t\r`)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if want := "\\x\n\t\r"; res.Text != want {
		t.Fatalf("Text = %q, want %q", res.Text, want)
	}
}

func TestDecodeSurrogatePair(t *testing.T) {
	res, err := Decode(`xy\uD83D\uDE00`)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if want := "xy\U0001F600"; res.Text != want {
		t.Fatalf("Text = %q, want %q", res.Text, want)
	}
	// The pair maps to one rune spanning both escapes.
	if got := res.RuneSpan(2); got != (Span{2, 14}) {
		t.Fatalf("pair span = %v, want {2,14}", got)
	}
	if n := len(res.Spans); n != 3 {
		t.Fatalf("len(Spans) = %d, want 3", n)
	}
}

func TestDecodeErrors(t *testing.T) {
	cases := []struct {
		src     string
		span    Span
		msgPart string
	}{
		{`\uD83D`, Span{0, 6}, "truncated escape"},
		{`\uD83Dabc`, Span{0, 6}, "unpaired high surrogate"},
		{`\uD83D\u0041`, Span{0, 12}, "not followed by low surrogate"},
		{`\uD83D\n`, Span{0, 6}, "unpaired high surrogate"},
		{`\uDE00`, Span{0, 6}, "unpaired low surrogate"},
		{`ab\uDC00`, Span{2, 8}, "unpaired low surrogate"},
		{`\x4G`, Span{0, 4}, "invalid hex digit"},
		{`\u12G4`, Span{0, 5}, "invalid hex digit"},
		{`\x`, Span{0, 2}, "truncated escape"},
		{`\U0001F60`, Span{0, 9}, "truncated escape"},
		{`\q`, Span{0, 2}, "unknown escape"},
		{`\U00110000`, Span{0, 10}, "invalid code point"},
		{`\U0000D800`, Span{0, 10}, "invalid code point"},
		{"a\xffb", Span{1, 2}, "invalid UTF-8"},
		{"ab\xc3", Span{2, 3}, "incomplete UTF-8"},
	}
	for _, c := range cases {
		_, err := Decode(c.src)
		if err == nil {
			t.Errorf("Decode(%q): expected error", c.src)
			continue
		}
		var e *Error
		if !errors.As(err, &e) {
			t.Errorf("Decode(%q): error type %T, want *Error", c.src, err)
			continue
		}
		if e.Span != c.span {
			t.Errorf("Decode(%q): span = %v, want %v", c.src, e.Span, c.span)
		}
		if !strings.Contains(e.Msg, c.msgPart) {
			t.Errorf("Decode(%q): msg = %q, want substring %q", c.src, e.Msg, c.msgPart)
		}
	}
}

// checkMapping verifies the decoded-position-to-source mapping: spans are
// contiguous, cover the whole source, and each span's source text decodes
// back to exactly the rune at that decoded position.
func checkMapping(t *testing.T, src string, res *Result) {
	t.Helper()
	runes := []rune(res.Text)
	if len(runes) != len(res.Spans) {
		t.Fatalf("decoded %d runes but %d spans", len(runes), len(res.Spans))
	}
	pos := 0
	for i, sp := range res.Spans {
		if sp.Start != pos {
			t.Fatalf("span %d = %v: not contiguous (previous end %d)", i, sp, pos)
		}
		if sp.End <= sp.Start || sp.End > len(src) {
			t.Fatalf("span %d = %v: out of range", i, sp)
		}
		pos = sp.End
		sub := src[sp.Start:sp.End]
		if sub[0] == '\\' {
			back, err := Decode(sub)
			if err != nil {
				t.Fatalf("re-decode of span %d %q: %v", i, sub, err)
			}
			if back.Text != string(runes[i]) {
				t.Fatalf("span %d %q re-decodes to %q, want %q", i, sub, back.Text, string(runes[i]))
			}
		} else if sub != string(runes[i]) {
			t.Fatalf("span %d = %q, want rune %q", i, sub, runes[i])
		}
	}
	if pos != len(src) {
		t.Fatalf("spans cover %d of %d source bytes", pos, len(src))
	}
}

func TestDecodePositionMapping(t *testing.T) {
	src := `Aé\x42\u4e2d\U0001F600\uD83D\uDE00\\` + "尾"
	res, err := Decode(src)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	want := "AéB中\U0001F600\U0001F600\\尾"
	if res.Text != want {
		t.Fatalf("Text = %q, want %q", res.Text, want)
	}
	checkMapping(t, src, res)
	// Spot-check: the surrogate pair rune maps back to both escapes.
	sp := res.RuneSpan(5)
	if src[sp.Start:sp.End] != `\uD83D\uDE00` {
		t.Fatalf("pair maps to %q", src[sp.Start:sp.End])
	}
}

func TestEncodeRoundTrip(t *testing.T) {
	cases := []string{
		"",
		"plain ascii 123 !?",
		"back\\slash",
		"tab\tnewline\ncr\r",
		"éñü",
		"中文日本語",
		"\U0001F600\U0001F4A9 mixed \u4e2d text",
		"\x00\x01\x1f\x7f",
		"every\\escape\n\t\r combined é中\U0001F600",
		strings.Repeat("aé中\U0001F600\\", 50),
	}
	for _, s := range cases {
		enc, err := Encode(s)
		if err != nil {
			t.Fatalf("Encode(%q): %v", s, err)
		}
		res, err := Decode(enc)
		if err != nil {
			t.Fatalf("Decode(Encode(%q)) = %q: %v", s, enc, err)
		}
		if res.Text != s {
			t.Fatalf("round trip of %q gave %q (encoded %q)", s, res.Text, enc)
		}
		checkMapping(t, enc, res)
	}
}

func TestEncodeInvalidUTF8(t *testing.T) {
	_, err := Encode("ok\xffbad")
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("error type %T, want *Error", err)
	}
	if e.Span != (Span{2, 3}) {
		t.Fatalf("span = %v, want {2,3}", e.Span)
	}
}

func TestRoundTripRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for iter := 0; iter < 500; iter++ {
		var sb strings.Builder
		for k := rng.Intn(40); k > 0; k-- {
			var r rune
			switch rng.Intn(6) {
			case 0:
				r = rune(rng.Intn(0x80)) // ASCII incl. backslash, controls
			case 1:
				r = 0x80 + rune(rng.Intn(0x80)) // Latin-1 supplement
			case 2:
				r = 0x100 + rune(rng.Intn(0xD800-0x100)) // BMP below surrogates
			case 3:
				r = 0xE000 + rune(rng.Intn(0x2000)) // BMP above surrogates
			case 4:
				r = 0x10000 + rune(rng.Intn(0x100000)) // non-BMP
			default:
				r = []rune("ab\\é中\U0001F600\n")[rng.Intn(7)]
			}
			sb.WriteRune(r)
		}
		s := sb.String()
		enc, err := Encode(s)
		if err != nil {
			t.Fatalf("iter %d: Encode(%q): %v", iter, s, err)
		}
		res, err := Decode(enc)
		if err != nil {
			t.Fatalf("iter %d: Decode(%q): %v", iter, enc, err)
		}
		if res.Text != s {
			t.Fatalf("iter %d: round trip of %q gave %q", iter, s, res.Text)
		}
		checkMapping(t, enc, res)
	}
}
