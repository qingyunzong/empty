package q225

import (
	"errors"
	"strings"
	"testing"
)

func TestChunkedBasicAndBytewise(t *testing.T) {
	wire := []byte("4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n")
	d := mustDecoder(t, teHeader("chunked"))
	payload, consumed, done, err := feedAllBytewise(t, d, wire)
	if err != nil {
		t.Fatalf("bytewise err=%v", err)
	}
	if !done || string(payload) != "Wikipedia" {
		t.Fatalf("done=%v payload=%q", done, payload)
	}
	if consumed != int64(len(wire)) || d.Consumed() != int64(len(wire)) {
		t.Fatalf("consumed=%d wire=%d", consumed, len(wire))
	}
	feedSplits(t, teHeader("chunked"), wire)
}

func TestChunkedHexSizes(t *testing.T) {
	wire := []byte("a\r\n0123456789\r\nA\r\nABCDEFGHIJ\r\n0\r\nX-T: v\r\n\r\n")
	d := mustDecoder(t, teHeader("chunked"))
	payload, _, done, err := feedAll(d, wire)
	if err != nil || !done {
		t.Fatalf("done=%v err=%v", done, err)
	}
	if payload != "0123456789ABCDEFGHIJ" {
		t.Fatalf("payload %q", payload)
	}
	if got := d.Trailers().Get("X-T"); got != "v" {
		t.Fatalf("trailer %q", got)
	}
}

func TestChunkExtensionQuotedSemicolon(t *testing.T) {
	// The semicolons inside the quoted parameter must not split params.
	wire := []byte("4;name=\"a;b;c\";flag\r\nWiki\r\n0\r\n\r\n")
	d := mustDecoder(t, teHeader("chunked"))
	payload, consumed, done, err := feedAll(d, wire)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if !done || payload != "Wiki" || consumed != int64(len(wire)) {
		t.Fatalf("done=%v payload=%q consumed=%d/%d", done, payload, consumed, len(wire))
	}
	feedSplits(t, teHeader("chunked"), wire)
}

func TestChunkExtensionQuotedPairAndTokenValues(t *testing.T) {
	wire := []byte("3;a=tok;b=\"q=1;x\\\"y\"\r\nabc\r\n0\r\n\r\n")
	d := mustDecoder(t, teHeader("chunked"))
	payload, consumed, done, err := feedAll(d, wire)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if !done || payload != "abc" || consumed != int64(len(wire)) {
		t.Fatalf("done=%v payload=%q consumed=%d/%d", done, payload, consumed, len(wire))
	}
}

func TestChunkExtensionAndSizeErrors(t *testing.T) {
	cases := map[string]string{
		"empty size":         "\r\nWiki\r\n0\r\n\r\n",
		"non-hex size":       "4z\r\nWiki\r\n0\r\n\r\n",
		"bad extension char": "4;na me\r\nWiki\r\n0\r\n\r\n",
		"unterminated quote": "4;n=\"abc\r\nWiki\r\n0\r\n\r\n",
		"missing value":      "4;n=\r\nWiki\r\n0\r\n\r\n",
		"equals first":       "4;=v\r\nWiki\r\n0\r\n\r\n",
		"control in quote":   "4;n=\"a\x01b\"\r\nWiki\r\n0\r\n\r\n",
		"oversized hex":      "fffffffffffffffff\r\n",
	}
	for name, wire := range cases {
		t.Run(name, func(t *testing.T) {
			d := mustDecoder(t, teHeader("chunked"))
			_, _, _, err := feedAll(d, []byte(wire))
			if !errors.Is(err, ErrChunkSyntax) {
				t.Fatalf("err=%v want ErrChunkSyntax", err)
			}
			if !d.Poisoned() {
				t.Fatal("connection not poisoned")
			}
		})
	}
}

func TestFakeZeroChunk(t *testing.T) {
	// "10" (16) contains a zero digit but is not the zero chunk; the
	// parser must keep reading chunk data.
	wire := []byte("10\r\n" + strings.Repeat("x", 16) + "\r\n0\r\n\r\n")
	d := mustDecoder(t, teHeader("chunked"))
	payload, consumed, done, err := feedAll(d, wire)
	if err != nil || !done {
		t.Fatalf("done=%v err=%v", done, err)
	}
	if payload != strings.Repeat("x", 16) {
		t.Fatalf("payload len=%d", len(payload))
	}
	if consumed != int64(len(wire)) {
		t.Fatalf("consumed=%d wire=%d", consumed, len(wire))
	}

	// "00" with an extension is still the real terminator.
	wire2 := []byte("00;why=not\r\n\r\n")
	d2 := mustDecoder(t, teHeader("chunked"))
	payload2, consumed2, done2, err2 := feedAll(d2, wire2)
	if err2 != nil || !done2 || payload2 != "" {
		t.Fatalf("done=%v err=%v payload=%q", done2, err2, payload2)
	}
	if consumed2 != int64(len(wire2)) {
		t.Fatalf("consumed=%d wire=%d", consumed2, len(wire2))
	}
}

func TestStrictCRLF(t *testing.T) {
	cases := map[string][]byte{
		"lf after chunk size":   []byte("4\nWiki\r\n0\r\n\r\n"),
		"lf after chunk data":   []byte("4\r\nWiki\n0\r\n\r\n"),
		"lf trailer terminator": []byte("0\r\nX-T: v\r\n\n"),
		"bare cr size":          []byte("4\rWiki\r\n0\r\n\r\n"),
		"bare cr data":          []byte("4\r\nWiki\r0\r\n\r\n"),
	}
	for name, wire := range cases {
		t.Run(name, func(t *testing.T) {
			d := mustDecoder(t, teHeader("chunked"))
			_, _, _, err := feedAll(d, wire)
			if !errors.Is(err, ErrCRLF) {
				t.Fatalf("err=%v want ErrCRLF", err)
			}
			if !d.Poisoned() {
				t.Fatal("connection not poisoned after CRLF violation")
			}
		})
	}

	// A lone trailing CR with nothing after it means "need more input";
	// declaring EOF then turns it into a truncation error.
	d := mustDecoder(t, teHeader("chunked"))
	if _, _, done, err := d.Feed([]byte("4\r\nWiki\r")); err != nil || done {
		t.Fatalf("partial feed done=%v err=%v", done, err)
	}
	if err := d.Finish(); !errors.Is(err, ErrTruncated) {
		t.Fatalf("Finish err=%v want ErrTruncated", err)
	}

	// Once the LF arrives, the strict CRLF is accepted and parsing moves on.
	d2 := mustDecoder(t, teHeader("chunked"))
	_, _, done, err := feedAll(d2, []byte("4\r\nWiki\r\n0\r\n\r\n"))
	if err != nil || !done {
		t.Fatalf("done=%v err=%v", done, err)
	}
}

func TestChunkedTruncation(t *testing.T) {
	full := []byte("4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n")
	for cut := 0; cut < len(full); cut++ {
		d := mustDecoder(t, teHeader("chunked"))
		if _, _, _, err := feedAll(d, full[:cut]); err != nil {
			t.Fatalf("cut=%d unexpected early error: %v", cut, err)
		}
		if err := d.Finish(); !errors.Is(err, ErrTruncated) {
			t.Fatalf("cut=%d Finish err=%v want ErrTruncated", cut, err)
		}
		if !d.Poisoned() {
			t.Fatalf("cut=%d not poisoned", cut)
		}
	}
}

func TestChunkedOversizedChunkLine(t *testing.T) {
	limits := DefaultLimits
	limits.MaxChunkLine = 8
	d, err := NewDecoder(teHeader("chunked"), limits)
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, err = d.Feed([]byte("4;" + strings.Repeat("x", 20) + "\r\n"))
	if !errors.Is(err, ErrChunkLineTooLong) {
		t.Fatalf("err=%v want ErrChunkLineTooLong", err)
	}
}
