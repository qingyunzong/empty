package dataeng

import (
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"testing/iotest"
)

func values(records []*Record) [][]string {
	out := make([][]string, len(records))
	for i, rec := range records {
		out[i] = rec.Values()
	}
	return out
}

func mustParse(t *testing.T, data string, args ...any) []*Record {
	t.Helper()
	records, err := Parse([]byte(data), args...)
	if err != nil {
		t.Fatalf("Parse(%q): %v", data, err)
	}
	return records
}

func TestQuotedNewlineAndEscapedQuote(t *testing.T) {
	input := "a,\"b\nc\",d\nx,\"say \"\"hi\"\"\",z\n"
	records := mustParse(t, input)
	want := [][]string{
		{"a", "b\nc", "d"},
		{"x", `say "hi"`, "z"},
	}
	if got := values(records); !reflect.DeepEqual(got, want) {
		t.Fatalf("values = %#v, want %#v", got, want)
	}

	// Raw intervals include the quote tokens and point into the original input.
	gotRaw := string(records[0].Fields[1].Raw)
	if gotRaw != "\"b\nc\"" {
		t.Fatalf("quoted raw = %q", gotRaw)
	}
	if records[0].Fields[1].Start != 2 || records[0].Fields[1].End != 7 {
		t.Fatalf("quoted interval = [%d,%d), want [2,7)",
			records[0].Fields[1].Start, records[0].Fields[1].End)
	}
	if got := string(input[records[0].Fields[1].Start:records[0].Fields[1].End]); got != gotRaw {
		t.Fatalf("input slice = %q, want %q", got, gotRaw)
	}
}

func TestFieldIntervals(t *testing.T) {
	input := "aa,\"b\"\"c\",z"
	records := mustParse(t, input)
	if len(records) != 1 || len(records[0].Fields) != 3 {
		t.Fatalf("records = %#v", records)
	}
	rec := records[0]
	tests := []struct {
		start, end   int64
		cstart, cend int64
		raw, value   string
		quoted       bool
	}{
		{0, 2, 0, 2, "aa", "aa", false},
		{3, 9, 4, 8, "\"b\"\"c\"", `b"c`, true},
		{10, 11, 10, 11, "z", "z", false},
	}
	for i, want := range tests {
		f := rec.Fields[i]
		if f.Start != want.start || f.End != want.end ||
			f.ContentStart != want.cstart || f.ContentEnd != want.cend ||
			string(f.Raw) != want.raw || string(f.Value) != want.value || f.Quoted != want.quoted {
			t.Errorf("field %d = %+v, want %+v", i, f, want)
		}
	}
	if rec.Start != 0 || rec.End != int64(len(input)) {
		t.Errorf("record interval = [%d,%d)", rec.Start, rec.End)
	}
}

func TestMultiByteDelimiterAllChunkPositions(t *testing.T) {
	input := "a||\"b\nc\"||\"d||e\"||f\n" // the delimiter inside quotes is data
	want, err := Parse([]byte(input), WithDelimiter("||"))
	if err != nil {
		t.Fatal(err)
	}
	if got := values(want); !reflect.DeepEqual(got, [][]string{
		{"a", "b\nc", "d||e", "f"},
	}) {
		t.Fatalf("unexpected values: %#v", got)
	}

	for split := 0; split <= len(input); split++ {
		got, err := ParseChunks([][]byte{[]byte(input[:split]), []byte(input[split:])}, WithDelimiter("||"))
		if err != nil {
			t.Fatalf("split %d: %v", split, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("split %d differs:\n got %#v\nwant %#v", split, got, want)
		}
	}
}

func TestUTF8DelimiterAndOneByteChunks(t *testing.T) {
	input := "甲，乙，\"丙\n丁\"，戊\n"
	want, err := Parse([]byte(input), WithDelimiter("，"))
	if err != nil {
		t.Fatal(err)
	}
	if got := values(want); !reflect.DeepEqual(got, [][]string{{"甲", "乙", "丙\n丁", "戊"}}) {
		t.Fatalf("values = %#v", got)
	}

	rd := NewReader(strings.NewReader(input), WithDelimiter("，"))
	records, err := rd.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(records, want) {
		t.Fatalf("one reader result differs:\n got %#v\nwant %#v", records, want)
	}

	// Force the underlying reader to return one byte per Read.
	rd = NewReader(iotest.OneByteReader(strings.NewReader(input)), WithDelimiter("，"))
	records, err = rd.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(records, want) {
		t.Fatalf("one-byte reader result differs:\n got %#v\nwant %#v", records, want)
	}
}

func TestAllChunkPositionsComplex(t *testing.T) {
	input := "a,\"b\nc\",d\r\nx,\"say \"\"hi\"\"\",z\nq||r||s\n"
	opts := []any{WithDelimiter(",")}
	want, err := Parse([]byte(input), opts...)
	if err != nil {
		t.Fatal(err)
	}

	for split := 0; split <= len(input); split++ {
		got, err := ParseChunks([][]byte{[]byte(input[:split]), []byte(input[split:])}, opts...)
		if err != nil {
			t.Fatalf("split %d: %v", split, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("split %d differs:\n got %#v\nwant %#v", split, got, want)
		}
	}

	chunks := make([][]byte, len(input))
	for i := range input {
		chunks[i] = []byte{input[i]}
	}
	got, err := ParseChunks(chunks, opts...)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("one-byte chunks differ:\n got %#v\nwant %#v", got, want)
	}
}

func TestInvalidQuoteIsolatesPhysicalRecord(t *testing.T) {
	input := "a,b\"c,d\nnext,row\nlast,ok\n"
	records := mustParse(t, input)
	if len(records) != 3 {
		t.Fatalf("got %d records: %#v", len(records), records)
	}
	if !errors.Is(records[0].Err, ErrBareQuote) {
		t.Fatalf("first record error = %v, want ErrBareQuote", records[0].Err)
	}
	if got := values(records[1:]); !reflect.DeepEqual(got, [][]string{{"next", "row"}, {"last", "ok"}}) {
		t.Fatalf("records after error = %#v", got)
	}
}

func TestInvalidClosingQuoteIsolatesPhysicalRecord(t *testing.T) {
	input := "\"a\"x,b\nnext,row\n"
	records := mustParse(t, input)
	if len(records) != 2 {
		t.Fatalf("got %d records: %#v", len(records), records)
	}
	if !errors.Is(records[0].Err, ErrQuote) {
		t.Fatalf("first record error = %v, want ErrQuote", records[0].Err)
	}
	if got := values(records[1:]); !reflect.DeepEqual(got, [][]string{{"next", "row"}}) {
		t.Fatalf("records after error = %#v", got)
	}
}

func TestOversizedFieldStillFindsNextRecord(t *testing.T) {
	input := "a,\"" + strings.Repeat("x", 200) + "\",z\nnext,row\n"
	records := mustParse(t, input, WithMaxFieldSize(10))
	if len(records) != 2 {
		t.Fatalf("got %d records", len(records))
	}
	if !errors.Is(records[0].Err, ErrFieldTooLarge) {
		t.Fatalf("first error = %v", records[0].Err)
	}
	if got := values(records[1:]); !reflect.DeepEqual(got, [][]string{{"next", "row"}}) {
		t.Fatalf("next record = %#v", got)
	}
}

func TestOversizedRecordStillFindsNextRecord(t *testing.T) {
	input := "a,\"" + strings.Repeat("x", 200) + "\nwith newline\",z\nnext,row\n"
	records := mustParse(t, input, WithMaxRecordSize(32))
	if len(records) != 2 {
		t.Fatalf("got %d records: %#v", len(records), records)
	}
	if !errors.Is(records[0].Err, ErrRecordTooLarge) {
		t.Fatalf("first error = %v", records[0].Err)
	}
	if got := values(records[1:]); !reflect.DeepEqual(got, [][]string{{"next", "row"}}) {
		t.Fatalf("next record = %#v", got)
	}
}

func TestCRLFAndBlankLines(t *testing.T) {
	input := "a,b\r\n\r\nc,d\r\n"
	records := mustParse(t, input)
	if got := values(records); !reflect.DeepEqual(got, [][]string{{"a", "b"}, {"c", "d"}}) {
		t.Fatalf("values = %#v", got)
	}
	if records[0].End != 3 {
		t.Fatalf("CRLF record end = %d, want 3", records[0].End)
	}

	records = mustParse(t, input, WithKeepEmptyLines(true))
	if got := values(records); !reflect.DeepEqual(got, [][]string{{"a", "b"}, {""}, {"c", "d"}}) {
		t.Fatalf("with empty lines values = %#v", got)
	}
}

func TestInputOffset(t *testing.T) {
	rd := NewReader(strings.NewReader("a,b\nc,d\n"))
	rec, err := rd.Read()
	if err != nil {
		t.Fatal(err)
	}
	if rec.End != 3 {
		t.Fatalf("record end = %d", rec.End)
	}
	if got := rd.InputOffset(); got != 4 {
		t.Fatalf("InputOffset = %d, want 4", got)
	}
}

func TestReaderContinuesAfterParseErrors(t *testing.T) {
	input := "a,b\"c\nok,1\n\"bad\"x,2\nend,3\n"
	rd := NewReader(strings.NewReader(input))

	var got [][]string
	for {
		rec, err := rd.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			if rec == nil {
				t.Fatalf("nil record for parse error: %v", err)
			}
			if !errors.Is(err, ErrBareQuote) && !errors.Is(err, ErrQuote) {
				t.Fatalf("unexpected error: %v", err)
			}
		}
		got = append(got, rec.Values())
	}
	want := [][]string{{"a"}, {"ok", "1"}, nil, {"end", "3"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("values = %#v, want %#v", got, want)
	}
}

func TestOverlappingDelimiter(t *testing.T) {
	input := "aaabc\n"
	records := mustParse(t, input, WithDelimiter("aab"))
	if got := values(records); !reflect.DeepEqual(got, [][]string{{"a", "c"}}) {
		t.Fatalf("values = %#v", got)
	}
}

func TestLazyQuotes(t *testing.T) {
	input := "a,b\"c\nx,\"y\"z\"\n"
	records := mustParse(t, input, WithLazyQuotes(true))
	if got := values(records); !reflect.DeepEqual(got, [][]string{{"a", `b"c`}, {"x", `y"z`}}) {
		t.Fatalf("values = %#v", got)
	}
}
