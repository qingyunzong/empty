package q225

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

// TestPipelinedRequests proves the end position never swallows bytes of
// the next request on the same connection, for both framings and arbitrary
// feed boundaries.
func TestPipelinedRequests(t *testing.T) {
	firstCL := []byte("hello world")
	firstChunked := []byte("4\r\nWiki\r\n5\r\npedia\r\n0\r\nX-T: 1\r\n\r\n")
	next := []byte("POST /two HTTP/1.1\r\nHost: example\r\n\r\n")

	t.Run("content-length", func(t *testing.T) {
		wire := append(append([]byte{}, firstCL...), next...)
		d := mustDecoder(t, clHeader("11"))
		_, n, done, err := d.Feed(wire)
		if err != nil || !done {
			t.Fatalf("done=%v err=%v", done, err)
		}
		if !bytes.Equal(wire[n:], next) {
			t.Fatalf("next request altered: %q", wire[n:])
		}
		if d.Consumed() != int64(len(firstCL)) {
			t.Fatalf("consumed=%d", d.Consumed())
		}
	})

	t.Run("chunked", func(t *testing.T) {
		wire := append(append([]byte{}, firstChunked...), next...)
		d := mustDecoder(t, teHeader("chunked"))
		payload, consumed, done, err := feedAllBytewise(t, d, wire)
		if err != nil || !done {
			t.Fatalf("done=%v err=%v", done, err)
		}
		if string(payload) != "Wikipedia" {
			t.Fatalf("payload=%q", payload)
		}
		if consumed != int64(len(firstChunked)) {
			t.Fatalf("consumed=%d bodyWire=%d", consumed, len(firstChunked))
		}
		if !bytes.Equal(wire[consumed:], next) {
			t.Fatalf("next request swallowed: %q", wire[consumed:])
		}
		if d.Trailers().Get("X-T") != "1" {
			t.Fatal("trailer lost")
		}
	})

	t.Run("two sequential decoders", func(t *testing.T) {
		wire := append(append([]byte{}, firstCL...), firstCL...)
		d1 := mustDecoder(t, clHeader("11"))
		_, n1, done, err := d1.Feed(wire)
		if err != nil || !done || n1 != 11 {
			t.Fatalf("first: n=%d done=%v err=%v", n1, done, err)
		}
		d2 := mustDecoder(t, clHeader("11"))
		out, n2, done, err := d2.Feed(wire[n1:])
		if err != nil || !done {
			t.Fatalf("second: done=%v err=%v", done, err)
		}
		if string(out) != "hello world" || n2 != 11 {
			t.Fatalf("second payload=%q n=%d", out, n2)
		}
		if n1+n2 != len(wire) {
			t.Fatalf("total=%d wire=%d", n1+n2, len(wire))
		}
	})
}

// TestBackpressurePartialFeeds hands data to Feed in random small windows
// to confirm the parser makes progress without buffered reads and reports
// accurate positions at every boundary.
func TestBackpressurePartialFeeds(t *testing.T) {
	wire := []byte("3\r\nabc\r\n0\r\n\r\nTAIL")
	windows := []int{1, 1, 2, 3, 1, 4, 2, 100}
	d := mustDecoder(t, teHeader("chunked"))
	var payload bytes.Buffer
	off := 0
	for _, w := range windows {
		if off >= len(wire) {
			break
		}
		end := off + w
		if end > len(wire) {
			end = len(wire)
		}
		out, n, _, err := d.Feed(wire[off:end])
		if err != nil {
			t.Fatalf("window off=%d: %v", off, err)
		}
		payload.Write(out)
		off += n
		if d.Consumed() != int64(off) {
			t.Fatalf("consumed=%d off=%d", d.Consumed(), off)
		}
	}
	if payload.String() != "abc" {
		t.Fatalf("payload=%q", payload.String())
	}
	if !d.completed || d.Consumed() != int64(len(wire)-len("TAIL")) {
		t.Fatalf("completed=%v consumed=%d", d.completed, d.Consumed())
	}
	if string(wire[off:]) != "TAIL" {
		t.Fatalf("tail=%q", wire[off:])
	}
}

func TestAbortPoisons(t *testing.T) {
	d := mustDecoder(t, clHeader("10"))
	d.Abort()
	if !d.Poisoned() {
		t.Fatal("Abort did not poison")
	}
	if _, _, _, err := d.Feed([]byte("abc")); !errors.Is(err, ErrPoisoned) {
		t.Fatalf("err=%v", err)
	}
}

type slowReader struct {
	data []byte
}

func (s *slowReader) Read(p []byte) (int, error) {
	if len(s.data) == 0 {
		return 0, io.EOF
	}
	p[0] = s.data[0]
	s.data = s.data[1:]
	return 1, nil
}

func TestBodyReaderContentLength(t *testing.T) {
	wire := []byte("hello worldNEXT REQUEST BYTES")
	br, err := NewBodyReader(bytes.NewReader(wire), clHeader("11"), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(br)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if string(got) != "hello world" {
		t.Fatalf("payload=%q", got)
	}
	if br.Consumed() != 11 {
		t.Fatalf("consumed=%d", br.Consumed())
	}
	if string(br.Leftover()) != "NEXT REQUEST BYTES" {
		t.Fatalf("leftover=%q", br.Leftover())
	}
	if br.Framing() != FramingContentLength || br.Poisoned() {
		t.Fatalf("framing=%v poisoned=%v", br.Framing(), br.Poisoned())
	}
}

func TestBodyReaderByteAtATimeBackpressure(t *testing.T) {
	wire := []byte("4\r\nWiki\r\n5\r\npedia\r\n0\r\nX-T: v\r\n\r\n")
	br, err := NewBodyReader(&slowReader{data: append([]byte{}, wire...)}, teHeader("chunked"), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(br)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if string(got) != "Wikipedia" {
		t.Fatalf("payload=%q", got)
	}
	if br.Trailers().Get("X-T") != "v" {
		t.Fatalf("trailer=%q", br.Trailers().Get("X-T"))
	}
	// A byte-at-a-time source never over-reads, so there is nothing left
	// over while the exact end position is still reported.
	if len(br.Leftover()) != 0 {
		t.Fatalf("leftover=%q", br.Leftover())
	}
	if br.Consumed() != int64(len(wire)) {
		t.Fatalf("consumed=%d", br.Consumed())
	}
}

// TestBodyReaderBulkLeftover proves that when a connection read happens to
// contain the next pipelined request, those bytes are retained verbatim in
// Leftover instead of being swallowed.
func TestBodyReaderBulkLeftover(t *testing.T) {
	wire := []byte("4\r\nWiki\r\n0\r\n\r\nPIPELINED REQUEST")
	br, err := NewBodyReader(bytes.NewReader(wire), teHeader("chunked"), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(br)
	if err != nil || string(got) != "Wiki" {
		t.Fatalf("got=%q err=%v", got, err)
	}
	if string(br.Leftover()) != "PIPELINED REQUEST" {
		t.Fatalf("leftover=%q", br.Leftover())
	}
	if br.Consumed() != int64(len(wire)-len("PIPELINED REQUEST")) {
		t.Fatalf("consumed=%d", br.Consumed())
	}
}

func TestBodyReaderTruncated(t *testing.T) {
	br, err := NewBodyReader(strings.NewReader("4\r\nWi"), teHeader("chunked"), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(br)
	if !errors.Is(err, ErrTruncated) {
		t.Fatalf("err=%v want ErrTruncated", err)
	}
	if !br.Poisoned() || br.Err() == nil {
		t.Fatal("reader not poisoned")
	}
	if _, err := br.Read(make([]byte, 4)); !errors.Is(err, ErrPoisoned) {
		t.Fatalf("reuse err=%v want ErrPoisoned", err)
	}
}

func TestBodyReaderProtocolErrorPoisons(t *testing.T) {
	br, err := NewBodyReader(strings.NewReader("4\nWiki\r\n0\r\n\r\n"), teHeader("chunked"), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(br); !errors.Is(err, ErrCRLF) {
		t.Fatalf("err=%v want ErrCRLF", err)
	}
	if !br.Poisoned() {
		t.Fatal("connection reusable after protocol error")
	}
}

func TestBodyReaderEarlyClosePoisons(t *testing.T) {
	br, err := NewBodyReader(strings.NewReader("abcdefgh"), clHeader("8"), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 3)
	if n, err := br.Read(buf); err != nil || n != 3 || string(buf) != "abc" {
		t.Fatalf("n=%d err=%v buf=%q", n, err, buf)
	}
	if err := br.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !br.Poisoned() {
		t.Fatal("early Close did not poison")
	}
	if _, err := br.Read(buf); !errors.Is(err, ErrPoisoned) {
		t.Fatalf("post-close Read err=%v", err)
	}
}

func TestBodyReaderReadAfterEOFSticky(t *testing.T) {
	br, err := NewBodyReader(bytes.NewReader([]byte("abc")), clHeader("3"), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(br)
	if err != nil || string(got) != "abc" {
		t.Fatalf("got=%q err=%v", got, err)
	}
	if _, err := br.Read(make([]byte, 4)); err != io.EOF {
		t.Fatalf("second Read err=%v want io.EOF", err)
	}
	if br.Poisoned() {
		t.Fatal("clean EOF must keep the connection reusable")
	}
	if err := br.Close(); err != nil {
		t.Fatalf("Close after EOF: %v", err)
	}
}
