package esc

import (
	"errors"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

func streamDecode(t *testing.T, chunks ...string) (*Result, error) {
	t.Helper()
	var d StreamDecoder
	for _, c := range chunks {
		if err := d.Write([]byte(c)); err != nil {
			return nil, err
		}
	}
	return d.Close()
}

func TestStreamSurrogatePairAcrossChunks(t *testing.T) {
	res, err := streamDecode(t, `ab\uD8`, `3D`, `\uDE`, `00cd`)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if want := "ab\U0001F600cd"; res.Text != want {
		t.Fatalf("Text = %q, want %q", res.Text, want)
	}
	if got := res.RuneSpan(2); got != (Span{2, 14}) {
		t.Fatalf("pair span = %v, want {2,14}", got)
	}
}

func TestStreamSplitUTF8(t *testing.T) {
	res, err := streamDecode(t, "a\xc3", "\xa9b") // é split across chunks
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if want := "aéb"; res.Text != want {
		t.Fatalf("Text = %q, want %q", res.Text, want)
	}
	if got := res.RuneSpan(1); got != (Span{1, 3}) {
		t.Fatalf("é span = %v, want {1,3}", got)
	}
}

func TestStreamByteAtATimeEqualsOneShot(t *testing.T) {
	src := `a\x41é\u4e2d\U0001F600\uD83D\uDE00\\` + "尾\n"
	want, err := Decode(src)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	var d StreamDecoder
	for i := 0; i < len(src); i++ {
		if err := d.Write([]byte(src[i : i+1])); err != nil {
			t.Fatalf("Write at %d: %v", i, err)
		}
	}
	got, err := d.Close()
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got.Text != want.Text {
		t.Fatalf("Text = %q, want %q", got.Text, want.Text)
	}
	if !reflect.DeepEqual(got.Spans, want.Spans) {
		t.Fatalf("Spans = %v, want %v", got.Spans, want.Spans)
	}
}

func TestStreamRandomChunkingEqualsOneShot(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for iter := 0; iter < 300; iter++ {
		var sb strings.Builder
		for k := rng.Intn(30); k > 0; k-- {
			switch rng.Intn(4) {
			case 0:
				sb.WriteString(`\uD83D\uDE00`)
			case 1:
				sb.WriteString(`\x41`)
			case 2:
				sb.WriteString("é中")
			default:
				sb.WriteByte(byte('a' + rng.Intn(26)))
			}
		}
		src := sb.String()
		want, err := Decode(src)
		if err != nil {
			t.Fatalf("Decode(%q): %v", src, err)
		}
		var d StreamDecoder
		for i := 0; i < len(src); {
			n := 1 + rng.Intn(7)
			if i+n > len(src) {
				n = len(src) - i
			}
			if err := d.Write([]byte(src[i : i+n])); err != nil {
				t.Fatalf("iter %d: Write(%q): %v", iter, src[i:i+n], err)
			}
			i += n
		}
		got, err := d.Close()
		if err != nil {
			t.Fatalf("iter %d: Close: %v", iter, err)
		}
		if got.Text != want.Text || !reflect.DeepEqual(got.Spans, want.Spans) {
			t.Fatalf("iter %d: stream result differs for %q", iter, src)
		}
	}
}

func TestStreamErrorAbsoluteOffsets(t *testing.T) {
	var d StreamDecoder
	if err := d.Write([]byte("abc")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	err := d.Write([]byte(`\uDE00`))
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("error type %T, want *Error", err)
	}
	if e.Span != (Span{3, 9}) {
		t.Fatalf("span = %v, want {3,9}", e.Span)
	}
}

func TestStreamUnpairedSurrogateAcrossChunks(t *testing.T) {
	var d StreamDecoder
	if err := d.Write([]byte(`xy\uD83D`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	err := d.Write([]byte("zz"))
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("error type %T, want *Error", err)
	}
	if e.Span != (Span{2, 8}) {
		t.Fatalf("span = %v, want {2,8}", e.Span)
	}
	if !strings.Contains(e.Msg, "unpaired high surrogate") {
		t.Fatalf("msg = %q", e.Msg)
	}
}

func TestStreamTruncatedAtClose(t *testing.T) {
	var d StreamDecoder
	if err := d.Write([]byte(`ab\uD83`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	_, err := d.Close()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("error type %T, want *Error", err)
	}
	if e.Span != (Span{2, 7}) {
		t.Fatalf("span = %v, want {2,7}", e.Span)
	}
}

func TestStreamRoundTripWithMapping(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	for iter := 0; iter < 200; iter++ {
		var sb strings.Builder
		for k := rng.Intn(25); k > 0; k-- {
			sb.WriteRune(0x20 + rune(rng.Intn(0x10F000-0x20)))
		}
		// Rebuild from valid runes only (skip surrogates produced above).
		s := strings.Map(func(r rune) rune {
			if r >= 0xD800 && r <= 0xDFFF {
				return 'x'
			}
			return r
		}, sb.String())
		enc, err := Encode(s)
		if err != nil {
			t.Fatalf("iter %d: Encode: %v", iter, err)
		}
		var d StreamDecoder
		for i := 0; i < len(enc); {
			n := 1 + rng.Intn(11)
			if i+n > len(enc) {
				n = len(enc) - i
			}
			if err := d.Write([]byte(enc[i : i+n])); err != nil {
				t.Fatalf("iter %d: Write: %v", iter, err)
			}
			i += n
		}
		res, err := d.Close()
		if err != nil {
			t.Fatalf("iter %d: Close: %v", iter, err)
		}
		if res.Text != s {
			t.Fatalf("iter %d: stream round trip mismatch", iter)
		}
		checkMapping(t, enc, res)
	}
}
