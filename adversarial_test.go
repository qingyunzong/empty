package q225

import (
	"errors"
	"testing"
)

func TestChunkQuoteOnlyInExtension(t *testing.T) {
	// A quote in the size position is not hex and must be rejected rather
	// than treated as the start of a quoted parameter.
	cases := []string{
		"4\";x\"\r\nWiki\r\n0\r\n\r\n",
		"4\"abc\r\nWiki\r\n0\r\n\r\n",
		"4;x=\"unterminated\r\nWiki\r\n0\r\n\r\n",
		"4;=;a=b\r\nWiki\r\n0\r\n\r\n",
		"4;;\r\nWiki\r\n0\r\n\r\n",
		"4;x=bad token\r\nWiki\r\n0\r\n\r\n",
		"4;x=\"ok\"junk\r\nWiki\r\n0\r\n\r\n",
		"4;x=tok junk\r\nWiki\r\n0\r\n\r\n",
	}
	for _, raw := range cases {
		wire := []byte(raw)
		d := mustDecoder(t, teHeader("chunked"))
		_, _, _, err := feedAll(d, wire)
		if !errors.Is(err, ErrChunkSyntax) {
			t.Fatalf("wire=%q err=%v want ErrChunkSyntax", raw, err)
		}
		if !d.Poisoned() {
			t.Fatalf("wire=%q not poisoned", raw)
		}
	}
}

func TestFuzzishRandomSplitsNoPanic(t *testing.T) {
	// Deterministic pseudo-random split points over a range of valid and
	// invalid messages; every split must yield the same terminal result
	// and never panic.
	messages := [][]byte{
		[]byte("5\r\nhello\r\n0\r\nA: 1\r\n\r\n"),
		[]byte("0\r\n\r\n"),
		[]byte("3;e=\"x;y\"\r\nabc\r\n0\r\n\r\n"),
		[]byte("2\r\nhi\r\n0\r\n\r\n"),
		[]byte("4\r\noops\n0\r\n\r\n"),
		[]byte("zz\r\n"),
	}
	seed := int64(1)
	next := func() int {
		seed = seed*1103515245 + 12345
		return int((seed >> 16) & 0x7fff)
	}
	for _, wire := range messages {
		ref := mustDecoder(t, teHeader("chunked"))
		_, _, refDone, refErr := feedAll(ref, wire)
		for iter := 0; iter < 40; iter++ {
			d := mustDecoder(t, teHeader("chunked"))
			off := 0
			var done bool
			var err error
			for off < len(wire) {
				step := 1 + next()%5
				end := off + step
				if end > len(wire) {
					end = len(wire)
				}
				_, n, callDone, ferr := d.Feed(wire[off:end])
				off += n
				done = callDone
				err = ferr
				if ferr != nil {
					break
				}
				if n == 0 {
					// Feed needs the boundary bytes; widen the window.
					continue
				}
			}
			if errors.Is(refErr, nil) != errors.Is(err, nil) {
				t.Fatalf("wire=%q iter=%d err=%v want %v", wire, iter, err, refErr)
			}
			if refErr == nil && done != refDone {
				t.Fatalf("wire=%q iter=%d done=%v want %v", wire, iter, done, refDone)
			}
		}
	}
}

func TestConsumedMatchesBodyEndForContentLength(t *testing.T) {
	// Exact end offset across every one-byte boundary.
	body := []byte("exact-end")
	for extra := 0; extra <= 4; extra++ {
		wire := append(append([]byte{}, body...), make([]byte, extra)...)
		for i := range wire[len(body):] {
			wire[len(body)+i] = byte('A' + i)
		}
		d := mustDecoder(t, clHeader("9"))
		_, _, done, err := feedAllBytewise(t, d, wire)
		if err != nil || !done {
			t.Fatalf("extra=%d done=%v err=%v", extra, done, err)
		}
		if d.Consumed() != 9 {
			t.Fatalf("extra=%d consumed=%d", extra, d.Consumed())
		}
		if string(wire[d.Consumed():]) != string(wire[9:]) {
			t.Fatalf("extra=%d tail mismatch", extra)
		}
	}
}
