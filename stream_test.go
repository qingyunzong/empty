package stresc

import (
	"math/rand"
	"testing"
)

// feedAll feeds chunks to a Decoder, marking the last one final.
func feedAll(t *testing.T, chunks []string) (string, []Span, *Error) {
	t.Helper()
	var d Decoder
	for i, c := range chunks {
		if err := d.Feed(c, i == len(chunks)-1); err != nil {
			return "", nil, err
		}
	}
	return d.String(), d.Spans(), nil
}

func TestStreamingMatchesOneShot(t *testing.T) {
	sources := []string{
		`plain`,
		`\x41\x42\x43`,
		`A😀B`,
		`a\uD83D\uDE00b`, // surrogate pair, split candidates inside
		`x😀y`,
		"literal é😀 mix \\x41",
		`\n\t\\end`,
	}
	for _, src := range sources {
		want, wantMap, err := DecodeWithMap(src)
		if err != nil {
			t.Fatalf("DecodeWithMap(%q): %v", src, err)
		}
		// Every possible two-chunk split, including splits inside an
		// escape sequence and between the halves of a surrogate pair.
		for cut := 0; cut <= len(src); cut++ {
			got, spans, ferr := feedAll(t, []string{src[:cut], src[cut:]})
			if ferr != nil {
				t.Fatalf("src=%q cut=%d: %v", src, cut, ferr)
			}
			if got != want {
				t.Fatalf("src=%q cut=%d: got %q, want %q", src, cut, got, want)
			}
			for i := 0; i < wantMap.Len(); i++ {
				if spans[i] != wantMap.Lookup(i) {
					t.Fatalf("src=%q cut=%d: span[%d]=%v, want %v",
						src, cut, i, spans[i], wantMap.Lookup(i))
				}
			}
		}
		// Byte-at-a-time feeding.
		chunks := make([]string, len(src))
		for i := 0; i < len(src); i++ {
			chunks[i] = src[i : i+1]
		}
		got, spans, ferr := feedAll(t, chunks)
		if ferr != nil {
			t.Fatalf("src=%q byte-at-a-time: %v", src, ferr)
		}
		if got != want {
			t.Fatalf("src=%q byte-at-a-time: got %q, want %q", src, got, want)
		}
		for i := 0; i < wantMap.Len(); i++ {
			if spans[i] != wantMap.Lookup(i) {
				t.Fatalf("src=%q byte-at-a-time: span[%d]=%v, want %v",
					src, i, spans[i], wantMap.Lookup(i))
			}
		}
	}
}

func TestStreamingSurrogatePairAcrossChunks(t *testing.T) {
	// High surrogate ends chunk 1; low surrogate starts chunk 2.
	var d Decoder
	if err := d.Feed(`\uD83D`, false); err != nil {
		t.Fatalf("chunk 1: %v", err)
	}
	if got := d.String(); got != "" {
		t.Fatalf("after chunk 1 decoded %q, want empty (pair pending)", got)
	}
	if err := d.Feed(`\uDE00`, true); err != nil {
		t.Fatalf("chunk 2: %v", err)
	}
	if got := d.String(); got != "😀" {
		t.Fatalf("decoded %q, want 😀", got)
	}
	spans := d.Spans()
	if len(spans) != 1 || spans[0] != (Span{0, 12}) {
		t.Fatalf("spans = %v, want [{0 12}]", spans)
	}
}

func TestStreamingErrors(t *testing.T) {
	// Unpaired high surrogate discovered only when the next chunk arrives.
	var d Decoder
	if err := d.Feed(`ab\uD83D`, false); err != nil {
		t.Fatalf("chunk 1: %v", err)
	}
	if err := d.Feed(`x`, true); err == nil {
		t.Fatal("expected unpaired high surrogate error")
	} else if err.Span != (Span{2, 8}) {
		t.Fatalf("span = %v, want {2 8}", err.Span)
	}

	// Truncated escape at final chunk keeps the exact remaining range.
	var d2 Decoder
	if err := d2.Feed(`abc\x4`, true); err == nil {
		t.Fatal("expected truncated escape error")
	} else if err.Span != (Span{3, 6}) {
		t.Fatalf("span = %v, want {3 7}", err.Span)
	}

	// Error offsets are absolute across chunk boundaries.
	var d3 Decoder
	if err := d3.Feed(`ok`, false); err != nil {
		t.Fatal(err)
	}
	if err := d3.Feed(`\uDE00`, true); err == nil {
		t.Fatal("expected unpaired low surrogate error")
	} else if err.Span != (Span{2, 8}) {
		t.Fatalf("span = %v, want {2 8}", err.Span)
	}
}

func TestStreamingRoundTripRandomChunks(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for iter := 0; iter < 200; iter++ {
		n := rng.Intn(15)
		rs := make([]rune, n)
		for i := range rs {
			rs[i] = rune(1 + rng.Intn(0x10FFFF-1))
			for rs[i] >= 0xD800 && rs[i] <= 0xDFFF {
				rs[i] = rune(1 + rng.Intn(0x10FFFF-1))
			}
		}
		s := string(rs)
		enc := Encode(s, Options{EscapeAll: true})
		// Random chunking of the encoded form.
		var chunks []string
		for len(enc) > 0 {
			k := 1 + rng.Intn(len(enc))
			chunks = append(chunks, enc[:k])
			enc = enc[k:]
		}
		if len(chunks) == 0 {
			chunks = []string{""}
		}
		got, _, err := feedAll(t, chunks)
		if err != nil {
			t.Fatalf("iter %d: %v (chunks=%q)", iter, err, chunks)
		}
		if got != s {
			t.Fatalf("iter %d: got %q, want %q (chunks=%q)", iter, got, s, chunks)
		}
	}
}
