package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"testing"
)

func baseValidRecord(t *testing.T) []byte {
	t.Helper()
	return encodeRecord(t, []encodedField{
		controlField("001", "valid-001"),
		dataField("245", "1", "0",
			sub{'6', "880-01"},
			sub{'a', "Title"},
		),
		dataField("880", "1", "0",
			sub{'6', "245-01"},
			sub{'a', "标题"},
		),
	})
}

func reject(t *testing.T, raw []byte, wantLocal int64) *SyntaxError {
	t.Helper()
	_, err := ParseRecord(raw)
	var syntaxErr *SyntaxError
	if !errors.As(err, &syntaxErr) {
		t.Fatalf("error = %T %v, want *SyntaxError", err, err)
	}
	if wantLocal >= 0 && syntaxErr.LocalOffset != wantLocal {
		t.Fatalf("local offset = %d, want %d (%s)", syntaxErr.LocalOffset, wantLocal, syntaxErr.Reason)
	}
	if syntaxErr.LocalOffset < 0 {
		t.Fatalf("syntax error must carry a non-negative local offset: %#v", syntaxErr)
	}
	return syntaxErr
}

func TestRejectLeaderRules(t *testing.T) {
	raw := baseValidRecord(t)

	cases := []struct {
		name  string
		index int
		value byte
	}{
		{"record status", 9, 'b'},
		{"leader 10", 10, '1'},
		{"leader 11", 11, '1'},
		{"entry map", 20, '0'},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bad := bytes.Clone(raw)
			bad[tc.index] = tc.value
			want := int64(tc.index)
			if tc.index == 11 {
				want = 10
			}
			reject(t, bad, want)
		})
	}
}

func TestRejectLengthAndTerminator(t *testing.T) {
	raw := baseValidRecord(t)

	bad := bytes.Clone(raw)
	bad[len(bad)-1] = ft
	reject(t, bad, int64(len(bad)-1))

	bad = bytes.Clone(raw)
	bad[0] = 'x'
	reject(t, bad, 0)

	bad = bytes.Clone(raw)
	copy(bad[0:5], "00025")
	reject(t, bad, 0)
}

func TestRejectTag000(t *testing.T) {
	raw := encodeRecord(t, []encodedField{
		controlField("000", "forbidden"),
	})
	reject(t, raw, leaderLength)
}

func TestRejectBadControlContent(t *testing.T) {
	raw := encodeRecord(t, []encodedField{
		controlField("001", "ok"),
		controlField("008", "a\x1fb"),
	})
	reject(t, raw, -1) // offset asserted structurally below
}

func TestRejectInvalidUTF8(t *testing.T) {
	raw := encodeRecord(t, []encodedField{
		dataField("245", "1", "0", sub{'a', "ok\xffbad"}),
	})
	syntaxErr := reject(t, raw, -1)
	if !bytes.Contains([]byte(syntaxErr.Reason), []byte("UTF-8")) {
		t.Fatalf("reason should mention UTF-8: %s", syntaxErr.Reason)
	}
}

func TestRejectDataFieldWithoutSubfield(t *testing.T) {
	// Indicators plus only the field terminator: no delimiter sequence.
	body := append([]byte("  "), ft)
	raw := encodeRecord(t, []encodedField{
		{tag: "245", body: body},
	})
	reject(t, raw, -1)
}

func TestRejectBadIndicator(t *testing.T) {
	raw := encodeRecord(t, []encodedField{
		dataField("245", "\x1f", " ", sub{'a', "x"}),
	})
	reject(t, raw, -1)
}

func TestRejectLinkageRules(t *testing.T) {
	tests := []struct {
		name   string
		fields []encodedField
	}{
		{
			name: "ordinary points at non-880",
			fields: []encodedField{
				dataField("245", "1", "0",
					sub{'6', "250-01"},
					sub{'a', "x"}),
			},
		},
		{
			name: "880 points at 880",
			fields: []encodedField{
				dataField("880", "1", "0",
					sub{'6', "880-01"},
					sub{'a', "x"}),
			},
		},
		{
			name: "880 missing code 6",
			fields: []encodedField{
				dataField("880", "1", "0", sub{'a', "x"}),
			},
		},
		{
			name: "code 6 not first",
			fields: []encodedField{
				dataField("245", "1", "0",
					sub{'a', "x"},
					sub{'6', "880-01"}),
			},
		},
		{
			name: "malformed linkage",
			fields: []encodedField{
				dataField("245", "1", "0",
					sub{'6', "245-1"},
					sub{'a', "x"}),
			},
		},
		{
			name: "duplicate code 6",
			fields: []encodedField{
				dataField("245", "1", "0",
					sub{'6', "880-01"},
					sub{'6', "880-02"},
					sub{'a', "x"}),
			},
		},
		{
			name: "orphan ordinary field",
			fields: []encodedField{
				dataField("245", "1", "0",
					sub{'6', "880-09"},
					sub{'a', "x"}),
			},
		},
		{
			name: "orphan 880",
			fields: []encodedField{
				dataField("880", "1", "0",
					sub{'6', "245-09"},
					sub{'a', "x"}),
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			raw := encodeRecord(t, tc.fields)
			reject(t, raw, -1)
		})
	}
}

func TestRejectDuplicateOccurrence(t *testing.T) {
	raw := encodeRecord(t, []encodedField{
		dataField("245", "1", "0",
			sub{'6', "880-01"},
			sub{'a', "first"}),
		dataField("245", "1", "0",
			sub{'6', "880-01"},
			sub{'a', "second"}),
		dataField("880", "1", "0",
			sub{'6', "245-01"},
			sub{'a', "alt"}),
	})
	reject(t, raw, -1)
}

func TestRejectNonMutualPointer(t *testing.T) {
	// The ordinary field asks for occurrence 01 while the 880 answers with
	// occurrence 02: neither key has a counterpart, so the record is rejected
	// without guessing from nearby tags.
	raw := encodeRecord(t, []encodedField{
		dataField("245", "1", "0",
			sub{'6', "880-01"},
			sub{'a', "ordinary"}),
		dataField("880", "1", "0",
			sub{'6', "245-02"},
			sub{'a', "alternate"}),
	})
	reject(t, raw, -1)
}

func TestLinkageTargetTagBoundaries(t *testing.T) {
	// 880 may point at the lowest data tag 010 and the highest tag 999.
	raw := encodeRecord(t, []encodedField{
		dataField("010", " ", " ",
			sub{'6', "880-01"},
			sub{'a', "low"}),
		dataField("880", " ", " ",
			sub{'6', "010-01"},
			sub{'a', "low-alt"}),
		dataField("999", " ", " ",
			sub{'6', "880-02"},
			sub{'a', "high"}),
		dataField("880", " ", " ",
			sub{'6', "999-02"},
			sub{'a', "high-alt"}),
	})
	rec, err := ParseRecord(raw)
	if err != nil {
		t.Fatalf("boundary linkage rejected: %v", err)
	}
	if rec.Fields[0].LinkedIndex != 1 || rec.Fields[2].LinkedIndex != 3 {
		t.Fatalf("boundary linkage indices = %d/%d", rec.Fields[0].LinkedIndex, rec.Fields[2].LinkedIndex)
	}

	// An 880 pointing at a control-range tag must be rejected.
	bad := encodeRecord(t, []encodedField{
		dataField("880", " ", " ",
			sub{'6', "009-01"},
			sub{'a', "x"}),
	})
	reject(t, bad, -1)
}

func TestRejectOverlappingFieldRanges(t *testing.T) {
	raw := encodeRecord(t, []encodedField{
		controlField("001", "abcdef"),
		controlField("008", "ghijk"),
	})
	// Point the second entry at an offset already inside the first field.
	secondEntry := leaderLength + dirEntryLength
	copy(raw[secondEntry+7:secondEntry+12], fmt.Sprintf("%05d", 3))
	reject(t, raw, -1)
}

func TestHostSizeLimitRejectsDeclaredRecord(t *testing.T) {
	raw := baseValidRecord(t)
	r := NewReader(bytes.NewReader(raw), WithMaxRecordSize(len(raw)-1))
	_, err := r.Next()
	var syntaxErr *SyntaxError
	if !errors.As(err, &syntaxErr) {
		t.Fatalf("error = %T %v, want *SyntaxError", err, err)
	}
	if syntaxErr.RecordOffset != 0 {
		t.Fatalf("record offset = %d, want 0", syntaxErr.RecordOffset)
	}
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("reader after sole rejected record = %v, want EOF", err)
	}
}

func TestHostFieldLimit(t *testing.T) {
	raw := encodeRecord(t, []encodedField{
		controlField("001", "a"),
		controlField("008", "b"),
	})
	r := NewReader(bytes.NewReader(raw), WithMaxFields(1))
	_, err := r.Next()
	var syntaxErr *SyntaxError
	if !errors.As(err, &syntaxErr) {
		t.Fatalf("error = %T %v, want *SyntaxError", err, err)
	}
	// A field-count rejection consumes the whole record and keeps streaming.
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("post-limit error = %v, want EOF", err)
	}
}

func TestSyntaxErrorKeepsStreamReadable(t *testing.T) {
	good := baseValidRecord(t)
	bad := encodeRecord(t, []encodedField{
		dataField("880", "1", "0", sub{'a', "missing code 6"}),
	})
	stream := bytes.NewReader(append(bytes.Clone(good), bad...))
	r := NewReader(stream)

	first := mustNext(t, r)
	if len(first.Fields) != 3 {
		t.Fatalf("good prefix has %d fields", len(first.Fields))
	}
	if _, err := r.Next(); err == nil {
		t.Fatalf("bad record was delivered")
	} else {
		var syntaxErr *SyntaxError
		if !errors.As(err, &syntaxErr) {
			t.Fatalf("bad record error = %T, want *SyntaxError", err)
		}
		if syntaxErr.RecordOffset != int64(len(good)) {
			t.Fatalf("bad record start = %d, want %d", syntaxErr.RecordOffset, len(good))
		}
	}
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("after rejected record = %v, want EOF", err)
	}
}

func TestByteByByteStreamingOfMultipleRecords(t *testing.T) {
	first := baseValidRecord(t)
	second := encodeRecord(t, []encodedField{
		controlField("001", "second"),
		dataField("245", "1", "0", sub{'a', "Another"}),
	})
	combined := append(bytes.Clone(first), second...)
	r := NewReader(&chunkReader{data: combined})

	got1 := mustNext(t, r)
	got2 := mustNext(t, r)
	if got1.Range.Start != 0 || got2.Range.Start != int64(len(first)) {
		t.Fatalf("ranges = [%d] [%d]", got1.Range.Start, got2.Range.Start)
	}
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("end error = %v, want EOF", err)
	}

	// Subfield ranges resolve against the shifted record.
	value, err := got2.Slice(got2.Fields[1].Subfields[0].ValueRange)
	if err != nil || string(value) != "Another" {
		t.Fatalf("shifted subfield slice = %q, %v", value, err)
	}
}

func TestCleanEmptyStream(t *testing.T) {
	if _, err := NewReader(bytes.NewReader(nil)).Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("empty stream error = %v, want EOF", err)
	}
}

func TestTruncatedLeaderReportsLocalOffset(t *testing.T) {
	raw := baseValidRecord(t)
	r := NewReader(bytes.NewReader(raw[:3]))
	_, err := r.Next()
	var truncErr *TruncatedError
	if !errors.As(err, &truncErr) {
		t.Fatalf("error = %T %v, want *TruncatedError", err, err)
	}
	if truncErr.LocalOffset != 3 {
		t.Fatalf("local offset = %d, want 3", truncErr.LocalOffset)
	}
}

func TestOversizedDeclaredRecordTruncation(t *testing.T) {
	good := baseValidRecord(t)
	// Declare a record larger than the host limit, then end the stream
	// before all declared bytes can be discarded.
	declared := make([]byte, 5)
	copy(declared, "00500")
	partial := append(bytes.Clone(declared), make([]byte, 40)...)
	stream := bytes.NewReader(append(bytes.Clone(good), partial...))
	r := NewReader(stream, WithMaxRecordSize(120))

	delivered := mustNext(t, r)
	if delivered.Range.End != int64(len(good)) {
		t.Fatalf("delivered prefix end = %d, want %d", delivered.Range.End, len(good))
	}
	_, err := r.Next()
	var truncErr *TruncatedError
	if !errors.As(err, &truncErr) {
		t.Fatalf("error = %T %v, want *TruncatedError", err, err)
	}
	if truncErr.RecordOffset != int64(len(good)) {
		t.Fatalf("record start = %d, want %d", truncErr.RecordOffset, len(good))
	}
	if truncErr.LocalOffset != int64(len(partial)) {
		t.Fatalf("local offset = %d, want %d", truncErr.LocalOffset, len(partial))
	}
}

func TestEmptySubfieldValueAndControlRanges(t *testing.T) {
	raw := encodeRecord(t, []encodedField{
		controlField("001", ""),
		dataField("245", "1", "0",
			sub{'a', ""},
			sub{'b', "tail"}),
	})
	rec, err := ParseRecord(raw)
	if err != nil {
		t.Fatalf("empty values rejected: %v", err)
	}
	if rec.Fields[0].Content.Len() != 0 {
		t.Fatalf("empty control content range = %+v", rec.Fields[0].Content)
	}
	if rec.Fields[1].Subfields[0].ValueRange.Len() != 0 {
		t.Fatalf("empty subfield value range = %+v", rec.Fields[1].Subfields[0].ValueRange)
	}
	if got := valueAt(t, rec, rec.Fields[1].Subfields[1].ValueRange); got != "tail" {
		t.Fatalf("second subfield = %q", got)
	}
}

func TestZeroFieldRecordIsAccepted(t *testing.T) {
	// Leader + single directory terminator + record terminator: base 25,
	// total 26, with an empty but exactly tiled data area.
	leader := []byte("00026nam a2200025   4500")
	raw := append(append(leader, ft), rs)
	if len(raw) != 26 {
		t.Fatalf("fixture length = %d", len(raw))
	}
	rec, err := ParseRecord(raw)
	if err != nil {
		t.Fatalf("zero-field record rejected: %v", err)
	}
	if len(rec.Fields) != 0 {
		t.Fatalf("zero-field record produced %d fields", len(rec.Fields))
	}
}
