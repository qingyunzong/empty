package logsplit

import (
	"bytes"
	"math/rand"
	"testing"
)

// streamSplit feeds input to a Splitter in chunks of the given sizes
// (cycled) and returns all pieces, including the final one from Finish.
func streamSplit(input, delim []byte, chunkSizes ...int) [][]byte {
	s := New(delim)
	var pieces [][]byte
	for off, ci := 0, 0; off < len(input); ci++ {
		n := chunkSizes[ci%len(chunkSizes)]
		if n > len(input)-off {
			n = len(input) - off
		}
		pieces = append(pieces, s.Write(input[off:off+n])...)
		off += n
	}
	return append(pieces, s.Finish())
}

func equalPieces(a, b [][]byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !bytes.Equal(a[i], b[i]) {
			return false
		}
	}
	return true
}

func TestSplitCases(t *testing.T) {
	cases := []struct {
		name  string
		input string
		delim string
		want  []string
	}{
		{"empty input", "", ",", []string{""}},
		{"no delimiter", "abc", ",", []string{"abc"}},
		{"simple", "a,b,c", ",", []string{"a", "b", "c"}},
		{"empty pieces", ",,", ",", []string{"", "", ""}},
		{"trailing delimiter", "a,", ",", []string{"a", ""}},
		{"leading delimiter", ",a", ",", []string{"", "a"}},
		{"multi-byte delimiter", "a<>b<>c", "<>", []string{"a", "b", "c"}},
		{"delimiter prefix partial", "ab<a<ab", "<ab", []string{"ab<a", ""}},
		{"self overlap", "aaa", "aa", []string{"", "a"}},
		{"self overlap twice", "aaaa", "aa", []string{"", "", ""}},
		{"self overlap five", "aaaaa", "aa", []string{"", "", "a"}},
		{"overlap with border", "ababab", "abab", []string{"", "ab"}},
		{"escaped delimiter", `a\,b`, ",", []string{`a\,b`}},
		{"escaped then real", `a\,b,c`, ",", []string{`a\,b`, "c"}},
		{"escaped backslash then delimiter", `a\\,b`, ",", []string{`a\\`, "b"}},
		{"triple backslash then delimiter", `a\\\,b`, ",", []string{`a\\\,b`}},
		{"escape mid multi-byte delimiter", `a<\<>b`, "<>", []string{`a<\<>b`}},
		{"escape inside delimiter body", `a<\>b<>c`, "<>", []string{`a<\>b`, "c"}},
		{"trailing backslash", `ab\`, ",", []string{`ab\`}},
		{"trailing backslash after delimiter", `a,b\`, ",", []string{"a", `b\`}},
		{"backslash only", `\`, ",", []string{`\`}},
		{"delimiter is backslash never matches", `a\b`, `\`, []string{`a\b`}},
		{"single byte delim repeated", "xaxbx", "x", []string{"", "a", "b", ""}},
		{"binary bytes", "a\x00b\x00", "\x00", []string{"a", "b", ""}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Split([]byte(tc.input), []byte(tc.delim))
			want := make([][]byte, len(tc.want))
			for i, w := range tc.want {
				want[i] = []byte(w)
			}
			if !equalPieces(got, want) {
				t.Fatalf("Split(%q, %q) = %q, want %q", tc.input, tc.delim, got, want)
			}
			// The streaming splitter must agree for several chunkings,
			// including one byte at a time.
			for _, chunk := range [][]int{{1}, {2}, {3}, {len(tc.input) + 1}} {
				gotStream := streamSplit([]byte(tc.input), []byte(tc.delim), chunk...)
				if !equalPieces(gotStream, want) {
					t.Fatalf("streamSplit(%q, %q, chunk=%d) = %q, want %q",
						tc.input, tc.delim, chunk[0], gotStream, want)
				}
			}
		})
	}
}

// TestTrailingEscapeAcrossChunks checks that a backslash at the end of a
// chunk keeps the escape state unfinished, so the first byte of the next
// chunk is literalized.
func TestTrailingEscapeAcrossChunks(t *testing.T) {
	s := New([]byte(","))
	if got := s.Write([]byte(`a\`)); len(got) != 0 {
		t.Fatalf("first Write completed %d pieces, want 0", len(got))
	}
	if got := s.Write([]byte(",b")); len(got) != 0 {
		t.Fatalf("second Write completed %d pieces, want 0: %q", len(got), got)
	}
	if got := s.Write([]byte(",c")); len(got) != 1 || string(got[0]) != `a\,b` {
		t.Fatalf("third Write = %q, want [%q]", got, `a\,b`)
	}
	if got := s.Finish(); string(got) != "c" {
		t.Fatalf("Finish = %q, want %q", got, "c")
	}
}

// TestStreamMatchesReference feeds random inputs in random chunkings
// (including byte-by-byte) to a Splitter and compares the result with
// the whole-string reference scan.
func TestStreamMatchesReference(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	alphabet := []byte{'a', 'b', ',', '<', '>', '\\', 0, 0xff}
	delimAlphabet := []byte{'a', ',', '<', '\\'}

	for trial := 0; trial < 2000; trial++ {
		dlen := 1 + rng.Intn(3)
		delim := make([]byte, dlen)
		for i := range delim {
			delim[i] = delimAlphabet[rng.Intn(len(delimAlphabet))]
		}
		// A delimiter containing a backslash can never match because
		// backslash is always an escape character; skip the
		// uninteresting case.
		if bytes.IndexByte(delim, '\\') >= 0 {
			continue
		}

		n := rng.Intn(40)
		input := make([]byte, n)
		for i := range input {
			input[i] = alphabet[rng.Intn(len(alphabet))]
		}

		want := Split(input, delim)

		// Byte-by-byte chunking.
		if got := streamSplit(input, delim, 1); !equalPieces(got, want) {
			t.Fatalf("trial %d: byte-by-byte streamSplit(%q, %q) = %q, want %q",
				trial, input, delim, got, want)
		}
		// Random chunking.
		var chunks []int
		for remaining := n; remaining > 0; {
			c := 1 + rng.Intn(remaining)
			chunks = append(chunks, c)
			remaining -= c
		}
		if len(chunks) == 0 {
			chunks = []int{1}
		}
		if got := streamSplit(input, delim, chunks...); !equalPieces(got, want) {
			t.Fatalf("trial %d: streamSplit(%q, %q, chunks=%v) = %q, want %q",
				trial, input, delim, chunks, got, want)
		}
	}
}

func TestEmptyDelimiterPanics(t *testing.T) {
	for _, f := range []func(){
		func() { New(nil) },
		func() { Split([]byte("a"), nil) },
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatal("expected panic for empty delimiter")
				}
			}()
			f()
		}()
	}
}

func TestReuseAfterFinish(t *testing.T) {
	s := New([]byte(","))
	s.Write([]byte("a,b"))
	if got := s.Finish(); string(got) != "b" {
		t.Fatalf("Finish = %q, want %q", got, "b")
	}
	if got := s.Write([]byte("x,y")); len(got) != 1 || string(got[0]) != "x" {
		t.Fatalf("reused Write = %q, want [%q]", got, "x")
	}
	if got := s.Finish(); string(got) != "y" {
		t.Fatalf("reused Finish = %q, want %q", got, "y")
	}
}
