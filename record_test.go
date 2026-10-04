package recstream

import (
	"bytes"
	"io"
	"reflect"
	"testing"
)

func collectFed(t *testing.T, data []byte, chunkSize int) ([]Record, error) {
	t.Helper()
	d := NewDecoder()
	for pos := 0; pos < len(data); {
		n := chunkSize
		if n <= 0 || n > len(data)-pos {
			n = len(data) - pos
		}
		d.Write(data[pos : pos+n])
		pos += n
	}
	d.Close()
	return Collect(d)
}

var mixedRecords = []Record{
	{
		Encoding: UTF8,
		Points: []CodePoint{
			{Rune: 'h', Start: 0, End: 1},
			{Rune: 'é', Start: 1, End: 3},
			{Rune: 'l', Start: 3, End: 4},
			{Rune: 'l', Start: 4, End: 5},
			{Rune: 'o', Start: 5, End: 6},
		},
		Start: 0, End: 6,
	},
	{
		Encoding: UTF16LE,
		Points: []CodePoint{
			{Rune: 'A', Start: 9, End: 11},
			{Rune: '\U0001F600', Start: 11, End: 15},
		},
		Start: 9, End: 15,
	},
	{
		Encoding: UTF16BE,
		Points: []CodePoint{
			{Rune: '世', Start: 19, End: 21},
		},
		Start: 19, End: 21,
	},
	{
		Encoding: UTF8,
		Points: []CodePoint{
			{Rune: 'd', Start: 26, End: 27},
			{Rune: 'o', Start: 27, End: 28},
			{Rune: 'n', Start: 28, End: 29},
			{Rune: 'e', Start: 29, End: 30},
		},
		Start: 26, End: 30,
	},
}

func TestCollectMixedStream(t *testing.T) {
	for _, chunk := range []int{0, 1, 3, 7} {
		got, err := collectFed(t, mixedStream(), chunk)
		if err != nil {
			t.Fatalf("chunk %d: unexpected error: %v", chunk, err)
		}
		if !reflect.DeepEqual(got, mixedRecords) {
			t.Fatalf("chunk %d: records mismatch:\n got: %+v\nwant: %+v", chunk, got, mixedRecords)
		}
	}
	texts := []string{"héllo", "A\U0001F600", "世", "done"}
	for i, r := range mixedRecords {
		if r.Text() != texts[i] {
			t.Fatalf("record %d text = %q, want %q", i, r.Text(), texts[i])
		}
	}
}

// dripReader returns at most one byte per Read to stress chunk splitting.
type dripReader struct {
	data []byte
	pos  int
}

func (r *dripReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	p[0] = r.data[r.pos]
	r.pos++
	return 1, nil
}

func TestReadAll(t *testing.T) {
	got, err := ReadAll(&dripReader{data: mixedStream()})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(got, mixedRecords) {
		t.Fatalf("records mismatch:\n got: %+v\nwant: %+v", got, mixedRecords)
	}
}

func TestEmptyAndTerminatorOnly(t *testing.T) {
	got, err := ReadAll(bytes.NewReader(nil))
	if err != nil || len(got) != 0 {
		t.Fatalf("empty input: got %+v, %v", got, err)
	}
	got, err = ReadAll(bytes.NewReader([]byte("\n")))
	if err != nil || len(got) != 1 || got[0].Text() != "" {
		t.Fatalf("single newline: got %+v, %v", got, err)
	}
	got, err = ReadAll(bytes.NewReader([]byte("a\n\n")))
	if err != nil || len(got) != 2 || got[0].Text() != "a" || got[1].Text() != "" {
		t.Fatalf("trailing empty record: got %+v, %v", got, err)
	}
}
