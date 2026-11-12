package dataeng

import (
	"strings"
	"testing"
)

// header declares sep=',', term=';', esc='\'.
const header = ",;\\"

func newParser(t *testing.T, fieldBudget, envelopeBudget int) *Parser {
	t.Helper()
	p, err := NewParser(fieldBudget, envelopeBudget)
	if err != nil {
		t.Fatalf("NewParser: %v", err)
	}
	return p
}

// feedBytewise pumps the stream through the parser one byte per Feed call and
// reports the first error seen, mirroring a host that receives tiny chunks.
func feedBytewise(p *Parser, stream string) ([]Envelope, error) {
	var envs []Envelope
	var firstErr error
	for i := 0; i < len(stream); i++ {
		got, err := p.Feed([]byte{stream[i]})
		envs = append(envs, got...)
		if firstErr == nil && err != nil {
			firstErr = err
		}
	}
	return envs, firstErr
}

func mustParseError(t *testing.T, err error) *ParseError {
	t.Helper()
	pe, ok := err.(*ParseError)
	if !ok {
		t.Fatalf("expected *ParseError, got %T (%v)", err, err)
	}
	return pe
}

func TestConstructorRejectsNonPositiveBudgets(t *testing.T) {
	for _, tc := range [][2]int{{0, 1}, {1, 0}, {-3, 10}, {10, -1}} {
		if _, err := NewParser(tc[0], tc[1]); err == nil {
			t.Errorf("NewParser(%d, %d) succeeded, want error", tc[0], tc[1])
		}
	}
}

func TestSingleEnvelopeBytewise(t *testing.T) {
	stream := header + "BEGIN,c1;ROW,a,b;ROW,c;END,c1,2;"
	p := newParser(t, 16, 1024)
	envs, err := feedBytewise(p, stream)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := p.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(envs) != 1 {
		t.Fatalf("got %d envelopes, want 1", len(envs))
	}
	env := envs[0]
	if env.ControlID != "c1" {
		t.Errorf("ControlID = %q, want %q", env.ControlID, "c1")
	}
	if len(env.Rows) != 2 || env.Rows[0][0] != "a" || env.Rows[0][1] != "b" || env.Rows[1][0] != "c" {
		t.Errorf("Rows = %v", env.Rows)
	}
	if env.Offset != 3 {
		t.Errorf("Offset = %d, want 3", env.Offset)
	}
	if env.RawBytes != len(stream)-3 {
		t.Errorf("RawBytes = %d, want %d", env.RawBytes, len(stream)-3)
	}
}

func TestEscapedSeparatorBytewise(t *testing.T) {
	// Fields carry literal separator, terminator and escape characters.
	stream := header + `BEGIN,c1;ROW,a\,b,c\;d,e\\f;END,c1,1;`
	p := newParser(t, 16, 1024)
	envs, err := feedBytewise(p, stream)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(envs) != 1 {
		t.Fatalf("got %d envelopes, want 1", len(envs))
	}
	want := []string{"a,b", "c;d", `e\f`}
	row := envs[0].Rows[0]
	if len(row) != len(want) {
		t.Fatalf("row = %v, want %v", row, want)
	}
	for i := range want {
		if row[i] != want[i] {
			t.Errorf("row[%d] = %q, want %q", i, row[i], want[i])
		}
	}
}

func TestCountMismatchBytewise(t *testing.T) {
	bad := header + "BEGIN,c1;ROW,a;END,c1,2;"
	good := "BEGIN,c2;ROW,x;END,c2,1;"
	p := newParser(t, 16, 1024)

	envs, err := feedBytewise(p, bad)
	if len(envs) != 0 {
		t.Fatalf("revoked envelope was delivered: %v", envs)
	}
	pe := mustParseError(t, err)
	if !strings.Contains(pe.Reason, "row count mismatch") {
		t.Fatalf("reason = %q, want row count mismatch", pe.Reason)
	}
	// The terminator of the offending END segment sits at offset 26.
	if pe.Offset != 26 {
		t.Fatalf("offset = %d, want 26", pe.Offset)
	}

	// The parser resynchronises: a later intact envelope is still delivered.
	envs, err = feedBytewise(p, good)
	if err != nil {
		t.Fatalf("unexpected error after resync: %v", err)
	}
	if len(envs) != 1 || envs[0].ControlID != "c2" {
		t.Fatalf("envs = %v, want one c2 envelope", envs)
	}
}

func TestTruncationBytewise(t *testing.T) {
	cases := []struct {
		name   string
		stream string
		reason string
	}{
		{"header", ",;", "truncated header"},
		{"segment", header + "BEGIN,c", "truncated segment"},
		{"escape", header + "BEGIN,c1;ROW,a\\", "truncated escape sequence"},
		{"envelope", header + "BEGIN,c1;ROW,a;", "truncated envelope"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newParser(t, 16, 1024)
			envs, err := feedBytewise(p, tc.stream)
			if err != nil {
				t.Fatalf("unexpected feed error: %v", err)
			}
			if len(envs) != 0 {
				t.Fatalf("delivered %v from truncated stream", envs)
			}
			ferr := p.Finish()
			pe := mustParseError(t, ferr)
			if pe.Reason != tc.reason {
				t.Fatalf("reason = %q, want %q", pe.Reason, tc.reason)
			}
			if pe.Offset != int64(len(tc.stream)) {
				t.Fatalf("offset = %d, want %d", pe.Offset, len(tc.stream))
			}
		})
	}
}

func TestTruncationAfterCompletedEnvelope(t *testing.T) {
	stream := header + "BEGIN,c1;END,c1,0;BEGIN,c2;ROW,a;"
	p := newParser(t, 16, 1024)
	envs, err := feedBytewise(p, stream)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The completed envelope is retained even though the stream truncates.
	if len(envs) != 1 || envs[0].ControlID != "c1" {
		t.Fatalf("envs = %v, want the completed c1 envelope", envs)
	}
	if ferr := p.Finish(); ferr == nil {
		t.Fatal("Finish succeeded on truncated envelope")
	}
}

func TestNestedBeginRejected(t *testing.T) {
	stream := header + "BEGIN,c1;BEGIN,c2;"
	p := newParser(t, 16, 1024)
	envs, err := feedBytewise(p, stream)
	if len(envs) != 0 {
		t.Fatalf("envs = %v, want none", envs)
	}
	pe := mustParseError(t, err)
	if pe.Reason != "nested BEGIN" {
		t.Fatalf("reason = %q", pe.Reason)
	}
}

func TestRowOutsideEnvelopeRejected(t *testing.T) {
	stream := header + "ROW,a;"
	p := newParser(t, 16, 1024)
	envs, err := feedBytewise(p, stream)
	if len(envs) != 0 {
		t.Fatalf("envs = %v, want none", envs)
	}
	pe := mustParseError(t, err)
	if !strings.Contains(pe.Reason, "outside envelope") {
		t.Fatalf("reason = %q", pe.Reason)
	}
	if pe.Offset != int64(len(stream)-1) {
		t.Fatalf("offset = %d, want %d", pe.Offset, len(stream)-1)
	}
}

func TestFieldBudgetExceeded(t *testing.T) {
	stream := header + "BEGIN,c1;ROW,abcdef;END,c1,1;"
	p := newParser(t, 5, 1024)
	envs, err := feedBytewise(p, stream)
	if len(envs) != 0 {
		t.Fatalf("envs = %v, want none", envs)
	}
	pe := mustParseError(t, err)
	if pe.Reason != "field byte budget exceeded" {
		t.Fatalf("reason = %q", pe.Reason)
	}
	// Offset of the sixth byte of the over-long field "abcdef".
	want := int64(strings.Index(stream, "abcdef")) + 5
	if pe.Offset != want {
		t.Fatalf("offset = %d, want %d", pe.Offset, want)
	}
}

func TestEnvelopeBudgetExceeded(t *testing.T) {
	stream := header + "BEGIN,c1;ROW,a;END,c1,1;"
	p := newParser(t, 16, 12) // BEGIN segment alone spans 9 raw bytes
	envs, err := feedBytewise(p, stream)
	if len(envs) != 0 {
		t.Fatalf("envs = %v, want none", envs)
	}
	pe := mustParseError(t, err)
	if pe.Reason != "envelope raw byte budget exceeded" {
		t.Fatalf("reason = %q", pe.Reason)
	}
	if pe.Offset != 15 { // 13th raw byte of the envelope, 0-based
		t.Fatalf("offset = %d, want 15", pe.Offset)
	}
}

func TestCountFormat(t *testing.T) {
	cases := []struct {
		count  string
		reason string
	}{
		{"01", `invalid row count "01"`},
		{"00", `invalid row count "00"`},
		{"-1", `invalid row count "-1"`},
		{"1x", `invalid row count "1x"`},
		{"", `invalid row count ""`},
	}
	for _, tc := range cases {
		stream := header + "BEGIN,c1;ROW,a;END,c1," + tc.count + ";"
		p := newParser(t, 16, 1024)
		envs, err := feedBytewise(p, stream)
		if len(envs) != 0 {
			t.Fatalf("count %q: envs = %v, want none", tc.count, envs)
		}
		pe := mustParseError(t, err)
		if pe.Reason != tc.reason {
			t.Errorf("count %q: reason = %q, want %q", tc.count, pe.Reason, tc.reason)
		}
	}
}

func TestZeroRowsEnvelope(t *testing.T) {
	stream := header + "BEGIN,c1;END,c1,0;"
	p := newParser(t, 16, 1024)
	envs, err := feedBytewise(p, stream)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(envs) != 1 || len(envs[0].Rows) != 0 {
		t.Fatalf("envs = %v, want one empty envelope", envs)
	}
}

func TestHeaderValidation(t *testing.T) {
	t.Run("non-distinct", func(t *testing.T) {
		p := newParser(t, 16, 1024)
		_, err := feedBytewise(p, ",,\\BEGIN,c1;END,c1,0;")
		pe := mustParseError(t, err)
		if pe.Offset != 2 {
			t.Fatalf("offset = %d, want 2", pe.Offset)
		}
	})
	t.Run("non-ASCII", func(t *testing.T) {
		p := newParser(t, 16, 1024)
		_, err := feedBytewise(p, ",;\x80BEGIN,c1;END,c1,0;")
		pe := mustParseError(t, err)
		if pe.Offset != 2 {
			t.Fatalf("offset = %d, want 2", pe.Offset)
		}
	})
}

func TestSegmentShapeViolations(t *testing.T) {
	cases := []struct {
		name   string
		stream string
		reason string
	}{
		{"begin fields", header + "BEGIN,c1,extra;", "BEGIN requires exactly 2 fields, got 3"},
		{"begin empty id", header + "BEGIN,;", "BEGIN control ID must not be empty"},
		{"end fields", header + "BEGIN,c1;END,c1;", "END requires exactly 3 fields, got 2"},
		{"end id mismatch", header + "BEGIN,c1;END,c2,0;", `END control ID "c2" does not match "c1"`},
		{"unknown type", header + "BEGIN,c1;BOGUS,x;", `unknown segment type "BOGUS"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newParser(t, 16, 1024)
			envs, err := feedBytewise(p, tc.stream)
			if len(envs) != 0 {
				t.Fatalf("envs = %v, want none", envs)
			}
			pe := mustParseError(t, err)
			if pe.Reason != tc.reason {
				t.Fatalf("reason = %q, want %q", pe.Reason, tc.reason)
			}
		})
	}
}

func TestChunkSizeDoesNotChangeResult(t *testing.T) {
	stream := header + `BEGIN,c1;ROW,a\,b;ROW,c;END,c1,2;BEGIN,c2;END,c2,0;`
	for _, size := range []int{1, 2, 3, 7, len(stream)} {
		p := newParser(t, 16, 1024)
		var envs []Envelope
		for i := 0; i < len(stream); i += size {
			end := i + size
			if end > len(stream) {
				end = len(stream)
			}
			got, err := p.Feed([]byte(stream[i:end]))
			if err != nil {
				t.Fatalf("chunk %d: %v", size, err)
			}
			envs = append(envs, got...)
		}
		if len(envs) != 2 {
			t.Fatalf("chunk %d: got %d envelopes, want 2", size, len(envs))
		}
		if envs[0].Rows[0][0] != "a,b" || envs[1].ControlID != "c2" {
			t.Fatalf("chunk %d: envs = %v", size, envs)
		}
	}
}
