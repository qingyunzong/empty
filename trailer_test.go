package q225

import (
	"errors"
	"strings"
	"testing"
)

func TestTrailersParsed(t *testing.T) {
	wire := []byte("0\r\nX-One: 1\r\nx-two: two words\r\nX-One: second\r\n\r\n")
	d := mustDecoder(t, teHeader("chunked"))
	_, _, done, err := feedAll(d, wire)
	if err != nil || !done {
		t.Fatalf("done=%v err=%v", done, err)
	}
	tr := d.Trailers()
	if got := tr.Get("x-one"); got != "1" {
		t.Fatalf("X-One first=%q", got)
	}
	if got := tr.Values("X-One"); len(got) != 2 || got[1] != "second" {
		t.Fatalf("X-One values=%v", got)
	}
	if got := tr.Get("X-Two"); got != "two words" {
		t.Fatalf("X-Two=%q", got)
	}
	if d.Consumed() != int64(len(wire)) {
		t.Fatalf("consumed=%d wire=%d", d.Consumed(), len(wire))
	}
}

func TestForbiddenTrailers(t *testing.T) {
	names := []string{"Content-Length", "transfer-encoding", "HOST", "Trailer"}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			wire := []byte("0\r\n" + name + ": x\r\n\r\n")
			d := mustDecoder(t, teHeader("chunked"))
			_, _, _, err := feedAll(d, wire)
			if !errors.Is(err, ErrForbiddenTrailer) {
				t.Fatalf("err=%v want ErrForbiddenTrailer", err)
			}
			if !d.Poisoned() {
				t.Fatal("connection not poisoned")
			}
		})
	}
}

func TestTrailerSyntaxErrors(t *testing.T) {
	cases := map[string]string{
		"no colon":            "0\r\nX-Bad\r\n\r\n",
		"line folding":        "0\r\nX-T: v\r\n folded\r\n\r\n",
		"bad name byte":       "0\r\nX Bad: v\r\n\r\n",
		"control in value":    "0\r\nX-T: v\x00\r\n\r\n",
		"leading tab folding": "0\r\n\tX-T: v\r\n\r\n",
	}
	for name, wire := range cases {
		t.Run(name, func(t *testing.T) {
			d := mustDecoder(t, teHeader("chunked"))
			_, _, _, err := feedAll(d, []byte(wire))
			if !errors.Is(err, ErrTrailerSyntax) {
				t.Fatalf("err=%v want ErrTrailerSyntax", err)
			}
		})
	}
}

func TestTrailerLimits(t *testing.T) {
	t.Run("byte limit", func(t *testing.T) {
		limits := DefaultLimits
		limits.MaxTrailerBytes = 16
		d, err := NewDecoder(teHeader("chunked"), limits)
		if err != nil {
			t.Fatal(err)
		}
		_, _, _, err = d.Feed([]byte("0\r\nX-Long-Name: value value\r\n\r\n"))
		if !errors.Is(err, ErrTrailerTooLarge) {
			t.Fatalf("err=%v want ErrTrailerTooLarge", err)
		}
	})

	t.Run("field count limit", func(t *testing.T) {
		limits := DefaultLimits
		limits.MaxTrailerFields = 2
		d, err := NewDecoder(teHeader("chunked"), limits)
		if err != nil {
			t.Fatal(err)
		}
		wire := []byte("0\r\nA: 1\r\nB: 2\r\nC: 3\r\n\r\n")
		_, _, _, err = d.Feed(wire)
		if !errors.Is(err, ErrTrailerTooLarge) {
			t.Fatalf("err=%v want ErrTrailerTooLarge", err)
		}
	})

	t.Run("duplicate fields share count", func(t *testing.T) {
		limits := DefaultLimits
		limits.MaxTrailerFields = 1
		d, err := NewDecoder(teHeader("chunked"), limits)
		if err != nil {
			t.Fatal(err)
		}
		wire := []byte("0\r\nA: 1\r\nA: 2\r\n\r\n")
		_, _, done, err := d.Feed(wire)
		if err != nil || !done {
			t.Fatalf("done=%v err=%v", done, err)
		}
		if got := d.Trailers().Values("A"); len(got) != 2 {
			t.Fatalf("values=%v", got)
		}
	})
}

func TestTrailerSplitAcrossFeeds(t *testing.T) {
	wire := []byte("0\r\nX-T: value\r\n\r\n")
	d := mustDecoder(t, teHeader("chunked"))
	for i := 0; i < len(wire); i++ {
		_, _, done, err := d.Feed(wire[i : i+1])
		if err != nil {
			t.Fatalf("byte %d: %v", i, err)
		}
		if done && i != len(wire)-1 {
			t.Fatalf("finished early at %d", i)
		}
	}
	if got := d.Trailers().Get("X-T"); got != "value" {
		t.Fatalf("trailer=%q", got)
	}
	if d.trailerSz != len(wire)-len("0\r\n") {
		t.Fatalf("trailerSz=%d", d.trailerSz)
	}
}

func TestLargeBodyExceedsLimit(t *testing.T) {
	limits := DefaultLimits
	limits.MaxBodyBytes = 64
	d, err := NewDecoder(teHeader("chunked"), limits)
	if err != nil {
		t.Fatal(err)
	}
	wire := []byte("40\r\n" + strings.Repeat("z", 64) + "\r\n1\r\nx\r\n0\r\n\r\n")
	_, _, _, err = d.Feed(wire)
	if !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("err=%v want ErrBodyTooLarge", err)
	}
	if !d.Poisoned() {
		t.Fatal("not poisoned")
	}
}
