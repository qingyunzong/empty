package dataeng

import (
	"bytes"
	"io"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

func TestClosingQuoteBeforeBadDelimiterPrefix(t *testing.T) {
	input := "\"a\"|\nnext||row\n"
	records := mustParse(t, input, WithDelimiter("||"))
	if len(records) != 2 {
		t.Fatalf("got %d records: %#v", len(records), records)
	}
	if !errorsIs(records[0].Err, ErrQuote) {
		t.Fatalf("first error = %v", records[0].Err)
	}
	if got := records[1].Values(); !reflect.DeepEqual(got, []string{"next", "row"}) {
		t.Fatalf("second record = %#v", got)
	}
}

func errorsIs(err, target error) bool {
	for err != nil {
		if err == target {
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

func TestCommentLineWithQuoteDoesNotEscapeRecord(t *testing.T) {
	input := "# comment with \" quote\r\nnext,row\n"
	records := mustParse(t, input, WithComment("#"))
	if got := values(records); !reflect.DeepEqual(got, [][]string{{"next", "row"}}) {
		t.Fatalf("values = %#v", got)
	}
}

func TestMultiByteCommentAcrossChunks(t *testing.T) {
	input := "#! comment with \" quote\nnext,row\n"
	want, err := Parse([]byte(input), WithComment("#!"))
	if err != nil {
		t.Fatal(err)
	}
	if got := values(want); !reflect.DeepEqual(got, [][]string{{"next", "row"}}) {
		t.Fatalf("values = %#v", got)
	}
	for split := 0; split <= len(input); split++ {
		got, err := ParseChunks([][]byte{[]byte(input[:split]), []byte(input[split:])}, WithComment("#!"))
		if err != nil {
			t.Fatalf("split %d: %v", split, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("split %d differs: got %#v want %#v", split, got, want)
		}
	}
}

func TestRandomChunkPartitions(t *testing.T) {
	inputs := []string{
		"a,b,c\n1,2,3\n",
		"a,\"b\nc\",d\n",
		"a,\"b\"\"c\",d\n",
		"a,b\"c,d\nnext,row\n",
		"\"a\"x,b\nnext,row\n",
		"a||\"b\nc\"||d\n",
		"甲，乙，\"丙\n丁\"，戊\n",
	}
	configs := [][]any{
		nil,
		{WithDelimiter("||")},
		{WithDelimiter("，")},
	}

	rng := rand.New(rand.NewSource(41))
	for _, input := range inputs {
		for _, opts := range configs {
			want, err := Parse([]byte(input), opts...)
			if err != nil {
				t.Fatalf("Parse(%q): %v", input, err)
			}
			checkIntervals(t, input, want)
			for trial := 0; trial < 100; trial++ {
				var chunks [][]byte
				for pos := 0; pos < len(input); {
					n := rng.Intn(5) + 1
					if pos+n > len(input) {
						n = len(input) - pos
					}
					chunks = append(chunks, []byte(input[pos:pos+n]))
					pos += n
				}
				got, err := ParseChunks(chunks, opts...)
				if err != nil {
					t.Fatalf("chunks for %q: %v", input, err)
				}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("chunk mismatch for %q:\n got %#v\nwant %#v", input, got, want)
				}
				checkIntervals(t, input, got)

				all := make([]any, 0, len(opts)+1)
				all = append(all, &byteReader{data: []byte(input)})
				all = append(all, opts...)
				records, err := NewReader(all...).ReadAll()
				if err != nil {
					t.Fatalf("reader for %q: %v", input, err)
				}
				if !reflect.DeepEqual(records, want) {
					t.Fatalf("reader mismatch for %q:\n got %#v\nwant %#v", input, records, want)
				}
			}
		}
	}
}

func checkIntervals(t *testing.T, input string, records []*Record) {
	t.Helper()
	data := []byte(input)
	for _, rec := range records {
		if rec.Start < 0 || rec.End < rec.Start || rec.End > int64(len(data)) {
			t.Fatalf("bad record interval [%d,%d) for %q", rec.Start, rec.End, input)
		}
		if string(rec.Raw) != string(data[rec.Start:rec.End]) {
			t.Fatalf("record raw %q != input slice %q", rec.Raw, data[rec.Start:rec.End])
		}
		for _, f := range rec.Fields {
			if f.Start < rec.Start || f.End < f.Start || f.End > rec.End {
				t.Fatalf("bad field interval [%d,%d) in record [%d,%d)", f.Start, f.End, rec.Start, rec.End)
			}
			if string(f.Raw) != string(data[f.Start:f.End]) {
				t.Fatalf("field raw %q != input slice %q", f.Raw, data[f.Start:f.End])
			}
		}
	}
}

type byteReader struct {
	data []byte
	rng  *rand.Rand
}

func (r *byteReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	if r.rng == nil {
		r.rng = rand.New(rand.NewSource(int64(len(r.data))))
	}
	n := r.rng.Intn(len(p)) + 1
	if n > len(r.data) {
		n = len(r.data)
	}
	copy(p, r.data[:n])
	r.data = r.data[n:]
	return n, nil
}

func TestReaderMatchesBytesReader(t *testing.T) {
	input := "a,\"b\nc\",d\r\nx,y,z\n"
	got, err := NewReader(strings.NewReader(input)).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	want, err := NewReader(bytes.NewReader([]byte(input))).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}
