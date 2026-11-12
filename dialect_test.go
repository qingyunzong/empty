package dataeng

import (
	"reflect"
	"testing"
)

func TestDetectMultilineQuotedField(t *testing.T) {
	data := []byte("a,b\n\"x\n\"\"y\"\"\",z\n")
	candidates := []Dialect{
		{Delimiter: ',', Quote: true, LineEnding: LF},
		{Delimiter: '\t', Quote: true, LineEnding: LF},
		{Delimiter: ',', Quote: true, LineEnding: CRLF},
	}

	got := Detect(data, candidates, false)
	if !got.Valid {
		t.Fatalf("Detect returned no valid candidate:\n%s", got.DescribeErrors())
	}
	if got.Index != 0 {
		t.Fatalf("selected candidate %d, want 0", got.Index)
	}

	wantRanges := []RecordRange{
		{Start: 0, End: 4},
		{Start: 4, End: len(data)},
	}
	if !reflect.DeepEqual(got.Records, wantRanges) {
		t.Fatalf("record ranges = %#v, want %#v", got.Records, wantRanges)
	}
	if got.Score != (Score{CompleteRecords: 2, ModeFrequency: 2, ModeColumns: 2}) {
		t.Fatalf("score = %#v", got.Score)
	}

	firstAttempt := got.Candidates[0]
	if firstAttempt.Error != nil {
		t.Fatalf("selected candidate has error: %v", firstAttempt.Error)
	}
	if len(firstAttempt.Records) != 2 {
		t.Fatalf("candidate 0 has %d records, want 2", len(firstAttempt.Records))
	}

	// Quoting is a reserved syntax feature: a raw quote is not data when the
	// candidate disables quoting.
	unquoted := Detect(data, []Dialect{{Delimiter: ',', Quote: false, LineEnding: LF}}, false)
	if unquoted.Valid {
		t.Fatal("quote-disabled candidate unexpectedly parsed raw double quotes")
	}
	if unquoted.Candidates[0].Error == nil || unquoted.Candidates[0].Error.Offset != 4 {
		t.Fatalf("unquoted error = %#v, want byte 4", unquoted.Candidates[0].Error)
	}
}

func TestDetectTruncatedFinalHalfCRLF(t *testing.T) {
	data := []byte("a,b\r\nc,d\r")
	candidate := Dialect{Delimiter: ',', Quote: true, LineEnding: CRLF}

	got := Detect(data, []Dialect{candidate}, true)
	if !got.Valid {
		t.Fatalf("truncated sample was rejected:\n%s", got.DescribeErrors())
	}
	wantRanges := []RecordRange{
		{Start: 0, End: 5},
		{Start: 5, End: len(data)},
	}
	if !reflect.DeepEqual(got.Records, wantRanges) {
		t.Fatalf("record ranges = %#v, want %#v", got.Records, wantRanges)
	}
	if got.Score != (Score{CompleteRecords: 1, ModeFrequency: 1, ModeColumns: 2}) {
		t.Fatalf("score = %#v", got.Score)
	}

	// A partial CRLF after a closing quote is also only tolerated because the
	// final record is marked truncated.
	quotedTrailingCR := []byte("\"a\"\r")
	truncated := Detect(quotedTrailingCR, []Dialect{candidate}, true)
	if !truncated.Valid {
		t.Fatalf("truncated quoted record was rejected: %v", truncated.Candidates[0].Error)
	}
	if truncated.Score.CompleteRecords != 0 {
		t.Fatalf("truncated record contributed to score: %#v", truncated.Score)
	}

	complete := Detect(quotedTrailingCR, []Dialect{candidate}, false)
	if complete.Valid {
		t.Fatal("complete sample accepted a lone CR after a closing quote")
	}
	if err := complete.Candidates[0].Error; err == nil || err.Offset != 3 {
		t.Fatalf("error = %#v, want offset 3", err)
	}
}

func TestDetectCandidateOrdinalBreaksExactTie(t *testing.T) {
	data := []byte("x,y\n")
	candidates := []Dialect{
		{Delimiter: ',', Quote: true, LineEnding: LF},
		{Delimiter: ',', Quote: true, LineEnding: CRLF},
	}

	got := Detect(data, candidates, false)
	if !got.Valid || got.Index != 0 {
		t.Fatalf("selected index = %d, valid = %t, want 0, true", got.Index, got.Valid)
	}
	if got.Candidates[0].Score != got.Candidates[1].Score {
		t.Fatalf("expected exact tie, got %#v and %#v",
			got.Candidates[0].Score, got.Candidates[1].Score)
	}
}

func TestDetectModeTieChoosesLargerColumnCount(t *testing.T) {
	data := []byte("a,b\nc,d,e\n")
	candidate := Dialect{Delimiter: ',', Quote: true, LineEnding: LF}

	got := Detect(data, []Dialect{candidate}, false)
	if !got.Valid {
		t.Fatalf("sample was rejected: %v", got.Candidates[0].Error)
	}
	if got.Score != (Score{CompleteRecords: 2, ModeFrequency: 1, ModeColumns: 3}) {
		t.Fatalf("score = %#v, want mode columns 3", got.Score)
	}
}

func TestDetectCompleteRecordCountIsPrimary(t *testing.T) {
	data := []byte("a,b\nc,d\ne,f\n")
	candidates := []Dialect{
		{Delimiter: ',', Quote: true, LineEnding: LF},
		{Delimiter: ',', Quote: true, LineEnding: CRLF},
	}

	got := Detect(data, candidates, false)
	if !got.Valid || got.Index != 0 {
		t.Fatalf("selected index = %d, valid = %t, want 0, true", got.Index, got.Valid)
	}
	if got.Score.CompleteRecords != 3 {
		t.Fatalf("complete records = %d, want 3", got.Score.CompleteRecords)
	}
	if got.Candidates[1].Score.CompleteRecords != 1 {
		t.Fatalf("CRLF candidate complete records = %d, want 1",
			got.Candidates[1].Score.CompleteRecords)
	}
}

func TestDetectModeFrequencyBeforeColumnCount(t *testing.T) {
	data := []byte("a,b\nc\n")
	candidates := []Dialect{
		{Delimiter: ',', Quote: true, LineEnding: LF},
		{Delimiter: '\t', Quote: true, LineEnding: LF},
	}

	got := Detect(data, candidates, false)
	if !got.Valid || got.Index != 1 {
		t.Fatalf("selected index = %d, valid = %t, want 1, true", got.Index, got.Valid)
	}
	if got.Score != (Score{CompleteRecords: 2, ModeFrequency: 2, ModeColumns: 1}) {
		t.Fatalf("score = %#v", got.Score)
	}
}

func TestParseNonConflictingReservedDelimiter(t *testing.T) {
	// CR is a valid delimiter under LF; a quote can also be a delimiter when
	// quoting is disabled.
	data := []byte("a\rb\nc\rd\n")
	dialect := Dialect{Delimiter: '\r', Quote: false, LineEnding: LF}
	records, err := Parse(data, dialect, false)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if want := []RecordRange{{Start: 0, End: 4}, {Start: 4, End: 8}}; !reflect.DeepEqual(records, want) {
		t.Fatalf("record ranges = %#v, want %#v", records, want)
	}

	records, err = Parse([]byte("a\"b\n"), Dialect{
		Delimiter: '"', Quote: false, LineEnding: LF,
	}, false)
	if err != nil || len(records) != 1 {
		t.Fatalf("quote delimiter parse = %#v, %v", records, err)
	}
}

func TestDetectReportsEarliestErrorForEveryInvalidCandidate(t *testing.T) {
	data := []byte("a,\"b\n")
	candidates := []Dialect{
		{Delimiter: ',', Quote: true, LineEnding: LF},
		{Delimiter: ';', Quote: true, LineEnding: LF},
		{Delimiter: ',', Quote: false, LineEnding: LF},
	}

	got := Detect(data, candidates, false)
	if got.Valid {
		t.Fatal("invalid sample unexpectedly selected a candidate")
	}
	if got.Index != -1 {
		t.Fatalf("index = %d, want -1", got.Index)
	}
	wantOffsets := []int{len(data), 2, 2}
	for i, want := range wantOffsets {
		err := got.Candidates[i].Error
		if err == nil {
			t.Fatalf("candidate %d has no error", i)
		}
		if err.Offset != want {
			t.Fatalf("candidate %d error offset = %d, want %d", i, err.Offset, want)
		}
		if err.Record != 0 {
			t.Fatalf("candidate %d error record = %d, want 0", i, err.Record)
		}
	}
}

func TestDetectRejectsTextAfterClosingQuote(t *testing.T) {
	data := []byte("\"a\"x,b\n")
	candidate := Dialect{Delimiter: ',', Quote: true, LineEnding: LF}

	got := Detect(data, []Dialect{candidate}, false)
	if got.Valid {
		t.Fatal("text after a closing quote was accepted")
	}
	err := got.Candidates[0].Error
	if err == nil || err.Offset != 3 || err.Record != 0 {
		t.Fatalf("error = %#v, want record 0 offset 3", err)
	}
}

func TestParseQuotedEscapesAndRanges(t *testing.T) {
	data := []byte("\"a\"\"b\",c\r\nx,y\r\n")
	dialect := Dialect{Delimiter: ',', Quote: true, LineEnding: CRLF}

	records, err := Parse(data, dialect, false)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	want := []RecordRange{
		{Start: 0, End: 10},
		{Start: 10, End: len(data)},
	}
	if !reflect.DeepEqual(records, want) {
		t.Fatalf("record ranges = %#v, want %#v", records, want)
	}
}
