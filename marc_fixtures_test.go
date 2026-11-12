package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"testing"
)

// Fixture 1: the directory order differs from the physical field order.
// Field 001 is physically last while remaining first in the directory.
func TestFixtureShuffledDirectory(t *testing.T) {
	f001 := controlField("001", "shuffled-001")
	f008 := controlField("008", "260101t20262026ch#d")
	f245 := dataField("245", "1", "0",
		sub{'6', "880-01"},
		sub{'a', "Shuffled title"},
	)
	f880 := dataField("880", "1", "0",
		sub{'6', "245-01"},
		sub{'a', "乱序标题"},
	)

	// Directory order: 001,008,245,880; physical order: 008,245,001,880.
	raw := encodeRecord(t, []encodedField{f001, f008, f245, f880}, 2, 0, 1, 3)
	rec, err := ParseRecord(raw)
	if err != nil {
		t.Fatalf("ParseRecord rejected shuffled record: %v", err)
	}
	if len(rec.Fields) != 4 {
		t.Fatalf("got %d fields, want 4", len(rec.Fields))
	}
	wantTags := []string{"001", "008", "245", "880"}
	for i, want := range wantTags {
		if rec.Fields[i].Tag != want || rec.Fields[i].DirectoryIndex != i {
			t.Fatalf("directory order not preserved at %d: got %s", i, rec.Fields[i].Tag)
		}
	}
	if rec.Fields[0].Range.Start <= rec.Fields[1].Range.Start {
		t.Fatalf("001 should be physically after 008")
	}
	if got := valueAt(t, rec, rec.Fields[0].Content); got != "shuffled-001" {
		t.Fatalf("001 content %q", got)
	}
	if rec.Fields[2].LinkedIndex != 3 || rec.Fields[3].LinkedIndex != 2 {
		t.Fatalf("linkage indices = %d/%d, want 3/2", rec.Fields[2].LinkedIndex, rec.Fields[3].LinkedIndex)
	}

	// The same bytes must survive byte-by-byte streaming.
	streamRec, err := NewReader(&chunkReader{data: raw}).Next()
	if err != nil {
		t.Fatalf("streaming shuffled record failed: %v", err)
	}
	if streamRec.Fields[2].Range.Start != rec.Fields[2].Range.Start {
		t.Fatalf("stream offsets should match in a single-record stream")
	}
}

// Fixture 2: two 245 fields, one unlinked and one linked, keeping repeated
// tags in directory order.
func TestFixtureRepeated245(t *testing.T) {
	first := dataField("245", "1", "0", sub{'a', "First title"})
	second := dataField("245", "1", "0",
		sub{'6', "880-02"},
		sub{'a', "Second title"},
	)
	alt := dataField("880", "1", "0",
		sub{'6', "245-02"},
		sub{'a', "第二个标题"},
	)
	raw := encodeRecord(t, []encodedField{
		controlField("001", "rep-245"),
		first,
		second,
		alt,
	})

	rec, err := ParseRecord(raw)
	if err != nil {
		t.Fatalf("ParseRecord rejected repeated 245: %v", err)
	}
	t245 := []int{1, 2}
	for _, idx := range t245 {
		if rec.Fields[idx].Tag != "245" {
			t.Fatalf("directory index %d is %s, want 245", idx, rec.Fields[idx].Tag)
		}
	}
	if rec.Fields[1].LinkedIndex != -1 {
		t.Fatalf("unlinked 245 must stay unpaired, got %d", rec.Fields[1].LinkedIndex)
	}
	if rec.Fields[2].LinkedIndex != 3 || rec.Fields[3].LinkedIndex != 2 {
		t.Fatalf("second 245/880 not paired")
	}
}

// Fixture 3: two independent occurrence numbers on different ordinary tags,
// each pairing with exactly one 880.
func TestFixtureTwoOccurrences(t *testing.T) {
	title245 := dataField("245", "1", "0",
		sub{'6', "880-01"},
		sub{'a', "Title one"},
	)
	title250 := dataField("250", " ", " ",
		sub{'6', "880-01"},
		sub{'a', "Edition one"},
	)
	alt245 := dataField("880", "1", "0",
		sub{'6', "245-01"},
		sub{'a', "标题一"},
	)
	alt250 := dataField("880", " ", " ",
		sub{'6', "250-01"},
		sub{'a', "版本一"},
	)
	raw := encodeRecord(t, []encodedField{
		controlField("001", "two-occ"),
		title245,
		title250,
		alt245,
		alt250,
	})

	rec, err := ParseRecord(raw)
	if err != nil {
		t.Fatalf("ParseRecord rejected two occurrences: %v", err)
	}
	wantPairs := map[int]int{1: 3, 2: 4, 3: 1, 4: 2}
	for dirIndex, want := range wantPairs {
		if rec.Fields[dirIndex].LinkedIndex != want {
			t.Fatalf("field %d linkage = %d, want %d", dirIndex, rec.Fields[dirIndex].LinkedIndex, want)
		}
	}
}

// Fixture 4: NN=00 is an independent alternate representation and must not
// require a matching ordinary field.
func TestFixtureOccurrence00Unpaired(t *testing.T) {
	alt := dataField("880", "1", "0",
		sub{'6', "245-00"},
		sub{'a', "独立异文"},
	)
	raw := encodeRecord(t, []encodedField{
		controlField("001", "occ-00"),
		dataField("245", "1", "0", sub{'a', "Only ordinary title"}),
		alt,
	})

	rec, err := ParseRecord(raw)
	if err != nil {
		t.Fatalf("ParseRecord rejected independent 880: %v", err)
	}
	if rec.Fields[2].Tag != "880" || rec.Fields[2].LinkedIndex != -1 {
		t.Fatalf("NN=00 880 must remain unpaired, got %+v", rec.Fields[2])
	}
	if rec.Fields[2].Linkage == nil || rec.Fields[2].Linkage.Occurrence != 0 {
		t.Fatalf("880 linkage not parsed: %+v", rec.Fields[2].Linkage)
	}
}

// Fixture 5: multibyte UTF-8 makes byte length differ from character count;
// directory lengths must count bytes, including the trailing terminator.
func TestFixtureMultibyteUTF8Length(t *testing.T) {
	multibyte := "書名" // 2 runes, 6 UTF-8 bytes
	field := dataField("245", "1", "0",
		sub{'a', multibyte},
		sub{'b', "x"},
	)
	raw := encodeRecord(t, []encodedField{
		controlField("001", "utf8"),
		field,
	})

	entryStart := leaderLength + 1*dirEntryLength
	declaredLength := mustDecimal(string(raw[entryStart+3 : entryStart+7]))
	wantLength := 2 + (2 + len(multibyte)) + (2 + 1) + 1
	if declaredLength != wantLength {
		t.Fatalf("directory length = %d, want byte length %d", declaredLength, wantLength)
	}

	rec, err := ParseRecord(raw)
	if err != nil {
		t.Fatalf("ParseRecord rejected UTF-8 record: %v", err)
	}
	got := valueAt(t, rec, rec.Fields[1].Subfields[0].ValueRange)
	if got != multibyte {
		t.Fatalf("UTF-8 value = %q, want %q", got, multibyte)
	}
	if rec.Fields[1].Subfields[0].ValueRange.Len() != int64(len(multibyte)) {
		t.Fatalf("value range must use byte length %d", len(multibyte))
	}
}

// Fixture 6: a hole in the physical field ranges must reject the whole
// record rather than guessing boundaries.
func TestFixtureDirectoryHole(t *testing.T) {
	good := encodeRecord(t, []encodedField{
		controlField("001", "hole"),
		controlField("008", "placeholder"),
	})

	// Hand-edit: grow the first field's declared length by 3 so the second
	// entry starts inside the first range, creating overlap plus an uncovered
	// tail instead of an exact tiling.
	bad := bytes.Clone(good)
	firstLen := mustDecimal(string(bad[27:31]))
	copy(bad[27:31], fmt5(firstLen+3))

	if _, err := ParseRecord(bad); err == nil {
		t.Fatalf("ParseRecord accepted a record with a directory hole")
	} else {
		var syntaxErr *SyntaxError
		if !errors.As(err, &syntaxErr) {
			t.Fatalf("hole error type = %T, want *SyntaxError", err)
		}
		if syntaxErr.LocalOffset <= 0 {
			t.Fatalf("hole error must carry a local byte offset, got %d", syntaxErr.LocalOffset)
		}
	}
}

// Fixture 7: a valid prefix is delivered, then the following record is cut
// short; truncation reports the current record start and local offset while
// the delivered prefix stays available.
func TestFixtureTruncationAfterPrefix(t *testing.T) {
	first := encodeRecord(t, []encodedField{
		controlField("001", "first"),
		dataField("245", "1", "0", sub{'a', "Delivered title"}),
	})
	second := encodeRecord(t, []encodedField{
		controlField("001", "second"),
		dataField("250", " ", " ", sub{'a', "Edition"}),
	})

	cutAt := len(second) - 4
	stream := bytes.NewReader(append(bytes.Clone(first), second[:cutAt]...))
	r := NewReader(stream)

	delivered := mustNext(t, r)
	if delivered.Range.Start != 0 || delivered.Range.End != int64(len(first)) {
		t.Fatalf("prefix record range = %+v, want [0,%d)", delivered.Range, len(first))
	}

	_, err := r.Next()
	var truncErr *TruncatedError
	if !errors.As(err, &truncErr) {
		t.Fatalf("second record error = %T %v, want *TruncatedError", err, err)
	}
	if truncErr.RecordOffset != int64(len(first)) {
		t.Fatalf("truncation start = %d, want %d", truncErr.RecordOffset, len(first))
	}
	if truncErr.LocalOffset != int64(cutAt) {
		t.Fatalf("local truncation offset = %d, want %d", truncErr.LocalOffset, cutAt)
	}

	// After a real truncation the stream is exhausted; the earlier record is
	// still intact through its owned bytes.
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("post-truncation error = %v, want io.EOF", err)
	}
	if got := valueAt(t, delivered, delivered.Fields[1].Subfields[0].ValueRange); got != "Delivered title" {
		t.Fatalf("delivered prefix mutated: %q", got)
	}
}

func fmt5(n int) string { return fmt.Sprintf("%05d", n) }
