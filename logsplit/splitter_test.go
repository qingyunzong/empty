package logsplit

import (
	"bytes"
	"fmt"
	"math/rand"
	"testing"
)

// referenceSplit is an independent whole-string implementation used to
// cross-check the streaming Splitter. It first decodes escapes into a
// token stream (each token is a byte plus a "literal" flag), then finds
// delimiter matches left to right, non-overlapping.
func referenceSplit(data, delim []byte) [][]byte {
	type token struct {
		b       byte
		literal bool
	}
	var toks []token
	escaped := false
	for _, b := range data {
		if escaped {
			toks = append(toks, token{b, true})
			escaped = false
			continue
		}
		if b == '\\' {
			escaped = true
			continue
		}
		toks = append(toks, token{b, false})
	}
	if escaped {
		toks = append(toks, token{'\\', true})
	}

	var recs [][]byte
	var cur []byte
	i := 0
	for i < len(toks) {
		if !toks[i].literal && len(toks)-i >= len(delim) {
			match := true
			for j := range delim {
				if toks[i+j].literal || toks[i+j].b != delim[j] {
					match = false
					break
				}
			}
			if match {
				recs = append(recs, cur)
				cur = nil
				i += len(delim)
				continue
			}
		}
		cur = append(cur, toks[i].b)
		i++
	}
	return append(recs, cur)
}

// runChunked feeds data to a Splitter using the given chunk sizes
// (cycled) and returns all records.
func runChunked(data, delim []byte, chunkSize int) [][]byte {
	s := NewSplitter(delim)
	var recs [][]byte
	for i := 0; i < len(data); i += chunkSize {
		end := i + chunkSize
		if end > len(data) {
			end = len(data)
		}
		s.Write(data[i:end])
		recs = append(recs, s.Drain()...)
	}
	return append(recs, s.Finish())
}

func equalRecords(a, b [][]byte) bool {
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

func fmtRecords(recs [][]byte) string {
	var buf bytes.Buffer
	for i, r := range recs {
		if i > 0 {
			buf.WriteString(", ")
		}
		fmt.Fprintf(&buf, "%q", r)
	}
	return "[" + buf.String() + "]"
}

func checkCase(t *testing.T, data, delim []byte) {
	t.Helper()
	want := referenceSplit(data, delim)

	// Byte-by-byte chunking must agree with the whole-string reference.
	got := runChunked(data, delim, 1)
	if !equalRecords(got, want) {
		t.Errorf("byte-by-byte: data=%q delim=%q: got %s, want %s",
			data, delim, fmtRecords(got), fmtRecords(want))
	}
	// Whole-string Write must agree too.
	got = runChunked(data, delim, len(data)+1)
	if !equalRecords(got, want) {
		t.Errorf("single chunk: data=%q delim=%q: got %s, want %s",
			data, delim, fmtRecords(got), fmtRecords(want))
	}
	// And the one-shot Split helper.
	got = Split(data, delim)
	if !equalRecords(got, want) {
		t.Errorf("Split: data=%q delim=%q: got %s, want %s",
			data, delim, fmtRecords(got), fmtRecords(want))
	}
}

func TestFixedCases(t *testing.T) {
	cases := []struct {
		data, delim string
	}{
		{"", ","},
		{",", ","},
		{"a,b,c", ","},
		{"a,,b", ","},
		{",a,", ","},
		// Escapes: literalized delimiter and backslash.
		{`a\,b,c`, ","},
		{`a\\,b`, ","},
		{`a\\\,b`, ","},
		{`\`, ","},
		{`a\`, ","},
		{`\,`, ","},
		// Self-overlapping delimiters, left-to-right non-overlapping.
		{"aaa", "aa"},
		{"aaaa", "aa"},
		{"aaaaa", "aa"},
		{"ababab", "ab"},
		{"aabaa", "aa"},
		{"abcabcabc", "abc"},
		{"aaaaaa", "aaa"},
		{"abababa", "aba"},
		// Escape breaking a partial delimiter match.
		{`a\ab`, "aa"},
		{`aa\aa`, "aa"},
		{`ab\cab`, "abc"},
		{`ab\`, "abc"},
		// Delimiter containing a backslash can never match.
		{`a\b`, `\`},
		{`a\\b`, `\`},
		{`a\\b`, `\\`},
		// Multi-byte delimiter with escapes inside it.
		{`x\a\byabz`, "ab"},
		{"delimiter", "delimiter"},
		{"delimite", "delimiter"},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("data=%q/delim=%q", c.data, c.delim), func(t *testing.T) {
			checkCase(t, []byte(c.data), []byte(c.delim))
		})
	}
}

// TestBlockTailEscape verifies that an escape introducer at the very end
// of a Write chunk keeps the splitter in the escaped state, so the first
// byte of the next chunk is literalized.
func TestBlockTailEscape(t *testing.T) {
	s := NewSplitter([]byte(","))
	s.Write([]byte(`a,b\`)) // chunk ends with a backslash
	if got := s.Drain(); len(got) != 1 || string(got[0]) != "a" {
		t.Fatalf("after first chunk: got %s", fmtRecords(got))
	}
	s.Write([]byte(",c,d")) // leading comma must be literalized
	got := append(s.Drain(), s.Finish())
	want := [][]byte{[]byte("b,c"), []byte("d")}
	if !equalRecords(got, want) {
		t.Fatalf("got %s, want %s", fmtRecords(got), fmtRecords(want))
	}
}

// TestRandomChunkSizes feeds random inputs in random chunk sizes and
// compares against the whole-string reference.
func TestRandomChunkSizes(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	alphabet := []byte(`a,b\`)
	for iter := 0; iter < 2000; iter++ {
		n := rng.Intn(40)
		data := make([]byte, n)
		for i := range data {
			data[i] = alphabet[rng.Intn(len(alphabet))]
		}
		dn := 1 + rng.Intn(3)
		delim := make([]byte, dn)
		for i := range delim {
			delim[i] = alphabet[rng.Intn(len(alphabet))]
		}
		want := referenceSplit(data, delim)

		// Random chunk sizes from 1 to 7.
		s := NewSplitter(delim)
		var got [][]byte
		for i := 0; i < len(data); {
			step := 1 + rng.Intn(7)
			if i+step > len(data) {
				step = len(data) - i
			}
			s.Write(data[i : i+step])
			got = append(got, s.Drain()...)
			i += step
		}
		got = append(got, s.Finish())
		if !equalRecords(got, want) {
			t.Fatalf("data=%q delim=%q: got %s, want %s",
				data, delim, fmtRecords(got), fmtRecords(want))
		}
	}
}

// TestRandomByteByByte cross-checks byte-by-byte feeding against the
// reference over random inputs, including self-overlapping delimiters.
func TestRandomByteByByte(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	for iter := 0; iter < 3000; iter++ {
		alpha := []byte(`aaab\`)[:3+rng.Intn(3)]
		n := rng.Intn(50)
		data := make([]byte, n)
		for i := range data {
			data[i] = alpha[rng.Intn(len(alpha))]
		}
		dn := 1 + rng.Intn(4)
		delim := make([]byte, dn)
		for i := range delim {
			delim[i] = alpha[rng.Intn(len(alpha))]
		}
		want := referenceSplit(data, delim)
		got := runChunked(data, delim, 1)
		if !equalRecords(got, want) {
			t.Fatalf("data=%q delim=%q: got %s, want %s",
				data, delim, fmtRecords(got), fmtRecords(want))
		}
	}
}

func TestEmptyDelimiterPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for empty delimiter")
		}
	}()
	NewSplitter(nil)
}
