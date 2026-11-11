package q225

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func TestFramingStringAndHeaderGet(t *testing.T) {
	cases := map[Framing]string{
		FramingNone:          "none",
		FramingContentLength: "content-length",
		FramingChunked:       "chunked",
	}
	for f, want := range cases {
		if f.String() != want {
			t.Fatalf("%d.String()=%q want %q", f, f.String(), want)
		}
	}
	h := Header{}
	if h.Get("Missing") != "" || h.Values("Missing") != nil {
		t.Fatal("empty header must return zero values")
	}
	h2 := Header{}
	h2["X-K"] = []string{"a", "b"}
	if h2.Get("x-k") != "a" || len(h2.Values("X-K")) != 2 {
		t.Fatal("case-insensitive lookup failed")
	}
}

func TestZeroLimitsUseDefaults(t *testing.T) {
	d, err := NewDecoder(clHeader("0"), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if d.limits != DefaultLimits {
		t.Fatalf("limits=%+v want defaults", d.limits)
	}
	if !d.completed || d.Framing() != FramingContentLength {
		t.Fatal("zero-length body should complete immediately")
	}
	if _, _, done, err := d.Feed([]byte("x")); err != nil || !done {
		t.Fatalf("zero body done=%v err=%v", done, err)
	}
	if d.Consumed() != 0 || d.Emitted() != 0 {
		t.Fatal("zero body must not consume bytes")
	}
}

func TestQuotedStringEdges(t *testing.T) {
	// Escaped quote inside the quoted value must not terminate it.
	wire := []byte("2;x=\"a\\\"b;c\"\r\nhi\r\n0\r\n\r\n")
	d := mustDecoder(t, teHeader("chunked"))
	payload, _, done, err := feedAll(d, wire)
	if err != nil || !done || payload != "hi" {
		t.Fatalf("done=%v err=%v payload=%q", done, err, payload)
	}

	// A trailing backslash with no escaped byte, and a quote as the only
	// quoted content, are both invalid quoted-strings.
	for _, bad := range []string{
		"2;x=\"abc\\\r\nhi\r\n0\r\n\r\n",
		"2;x=\";z\r\nhi\r\n0\r\n\r\n",
	} {
		d := mustDecoder(t, teHeader("chunked"))
		if _, _, _, err := feedAll(d, []byte(bad)); !errors.Is(err, ErrChunkSyntax) {
			t.Fatalf("err=%v want ErrChunkSyntax", err)
		}
	}
}

func TestContentLengthLargerThanInt32(t *testing.T) {
	wire := []byte("ok")
	d, err := NewDecoder(clHeader("4294967296"), DefaultLimits)
	if err != nil {
		t.Fatalf("64-bit length rejected: %v", err)
	}
	if d.remaining != 1<<32 {
		t.Fatalf("remaining=%d", d.remaining)
	}
	if _, _, done, _ := d.Feed(wire); done {
		t.Fatal("incomplete body must not report done")
	}
	if err := d.Finish(); !errors.Is(err, ErrTruncated) {
		t.Fatalf("err=%v", err)
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestBodyReaderTransportError(t *testing.T) {
	br, err := NewBodyReader(errReader{}, clHeader("4"), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(br); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("err=%v want io.ErrUnexpectedEOF", err)
	}
	if !br.Poisoned() {
		t.Fatal("transport error must poison the connection")
	}
	if br.Decoder() == nil || br.Emitted() != 0 {
		t.Fatal("accessor mismatch after transport error")
	}
}

func TestNewBodyReaderRejectsBadFraming(t *testing.T) {
	if _, err := NewBodyReader(strings.NewReader("x"), clHeader("1, 2"), DefaultLimits); !errors.Is(err, ErrBadContentLength) {
		t.Fatalf("err=%v", err)
	}
}

func TestChunkedZeroByteRead(t *testing.T) {
	br, err := NewBodyReader(strings.NewReader("0\r\n\r\n"), teHeader("chunked"), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := br.Read(nil); n != 0 || err != nil {
		t.Fatalf("zero-length Read n=%d err=%v", n, err)
	}
	got, err := io.ReadAll(br)
	if err != nil || len(got) != 0 {
		t.Fatalf("got=%q err=%v", got, err)
	}
	if br.Framing() != FramingChunked {
		t.Fatalf("framing=%v", br.Framing())
	}
}
