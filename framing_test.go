package q225

import (
	"errors"
	"testing"
)

func TestNewDecoderFramingValidation(t *testing.T) {
	cases := []struct {
		name   string
		header Header
		want   error
	}{
		{"no body", Header{}, nil},
		{"canonical length", clHeader("123"), nil},
		{"zero length", clHeader("0"), nil},
		{"chunked", teHeader("chunked"), nil},
		{"chunked uppercase", teHeader("ChuNKeD"), nil},
		{"duplicate length", Header{canonicalKey("Content-Length"): {"1", "2"}}, ErrDuplicateContentLength},
		{"comma list length", clHeader("1, 2"), ErrBadContentLength},
		{"whitespace length", clHeader(" 5 "), ErrBadContentLength},
		{"empty length", clHeader(""), ErrBadContentLength},
		{"signed length", clHeader("+5"), ErrBadContentLength},
		{"overflow length", clHeader("9223372036854775808"), ErrBadContentLength},
		{"both framings", Header{
			canonicalKey("Content-Length"):    {"3"},
			canonicalKey("Transfer-Encoding"): {"chunked"},
		}, ErrBothFramings},
		{"duplicate te", Header{canonicalKey("Transfer-Encoding"): {"chunked", "chunked"}}, ErrBadTransferEncoding},
		{"identity te", teHeader("identity"), ErrBadTransferEncoding},
		{"gzip chunked te", teHeader("gzip, chunked"), ErrBadTransferEncoding},
		{"te with parameter", teHeader("chunked;foo=bar"), ErrBadTransferEncoding},
		{"te with whitespace", teHeader(" chunked"), ErrBadTransferEncoding},
		{"empty te", teHeader(""), ErrBadTransferEncoding},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, err := NewDecoder(tc.header, DefaultLimits)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err=%v want %v", err, tc.want)
			}
			if err == nil && d == nil {
				t.Fatal("nil decoder without error")
			}
		})
	}
}

func TestContentLengthExactPosition(t *testing.T) {
	wire := []byte("hello worldNEXT REQUEST")
	d := mustDecoder(t, clHeader("11"))
	out, n, done, err := d.Feed(wire)
	if err != nil || !done {
		t.Fatalf("done=%v err=%v", done, err)
	}
	if string(out) != "hello world" {
		t.Fatalf("payload %q", out)
	}
	if n != 11 || d.Consumed() != 11 {
		t.Fatalf("consumed n=%d dec=%d", n, d.Consumed())
	}
	if string(wire[n:]) != "NEXT REQUEST" {
		t.Fatalf("next request swallowed: %q", wire[n:])
	}
}

func TestContentLengthBytewiseAndSplits(t *testing.T) {
	wire := []byte("abc")
	d := mustDecoder(t, clHeader("3"))
	payload, consumed, done, err := feedAllBytewise(t, d, wire)
	if err != nil || !done {
		t.Fatalf("done=%v err=%v", done, err)
	}
	if string(payload) != "abc" || consumed != 3 {
		t.Fatalf("payload=%q consumed=%d", payload, consumed)
	}
	feedSplits(t, clHeader("3"), wire)
}

func TestContentLengthTruncatedAndPoisoned(t *testing.T) {
	d := mustDecoder(t, clHeader("8"))
	out, n, done, err := d.Feed([]byte("abc"))
	if err != nil || done || n != 3 || string(out) != "abc" {
		t.Fatalf("unexpected n=%d done=%v err=%v out=%q", n, done, err, out)
	}
	if err := d.Finish(); !errors.Is(err, ErrTruncated) {
		t.Fatalf("Finish err=%v want ErrTruncated", err)
	}
	if !d.Poisoned() {
		t.Fatal("decoder not poisoned after truncation")
	}
	if _, _, _, err := d.Feed([]byte("x")); !errors.Is(err, ErrPoisoned) {
		t.Fatalf("post-error Feed err=%v want ErrPoisoned", err)
	}
	if _, _, _, err := d.Feed(nil); !errors.Is(err, ErrTruncated) {
		t.Fatalf("wrapped cause lost: err=%v", err)
	}
	if err := d.Finish(); !errors.Is(err, ErrPoisoned) {
		t.Fatalf("post-error Finish err=%v want ErrPoisoned", err)
	}
	if err := d.Finish(); !errors.Is(err, ErrTruncated) {
		t.Fatalf("Finish lost original cause: err=%v", err)
	}
}

func TestContentLengthBodyTooLarge(t *testing.T) {
	limits := DefaultLimits
	limits.MaxBodyBytes = 4
	d, err := NewDecoder(clHeader("8"), limits)
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, err = d.Feed([]byte("abcdefgh"))
	if !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("err=%v want ErrBodyTooLarge", err)
	}
	if d.Emitted() != 4 {
		t.Fatalf("emitted=%d want 4", d.Emitted())
	}
	if !d.Poisoned() {
		t.Fatal("connection not poisoned after size limit")
	}
}

func TestNoBodyConsumesNothing(t *testing.T) {
	d := mustDecoder(t, Header{})
	wire := []byte("GET /next HTTP/1.1\r\n")
	out, n, done, err := d.Feed(wire)
	if err != nil || !done || n != 0 || len(out) != 0 {
		t.Fatalf("n=%d done=%v err=%v out=%v", n, done, err, out)
	}
	if d.Consumed() != 0 {
		t.Fatalf("consumed=%d", d.Consumed())
	}
	if d.Framing() != FramingNone {
		t.Fatalf("framing=%v", d.Framing())
	}
}
