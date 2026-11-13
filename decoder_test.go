package dataeng_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"

	"example.org/dataeng/q0357"
)

// recordBytes constructs a wire record directly from the documented layout.
// It deliberately does not use the decoder under test.
func recordBytes(typ byte, request uint16, content, padding []byte) []byte {
	if len(content) > 0xffff {
		panic("test record content is too large")
	}
	if len(padding) > 0xff {
		panic("test record padding is too large")
	}

	header := make([]byte, 8)
	header[0] = 1
	header[1] = typ
	binary.BigEndian.PutUint16(header[2:4], request)
	binary.BigEndian.PutUint16(header[4:6], uint16(len(content)))
	header[6] = byte(len(padding))
	header[7] = 0

	out := append(header, content...)
	return append(out, padding...)
}

func statusBytes(app uint32, protocol byte) []byte {
	out := make([]byte, 8)
	binary.BigEndian.PutUint32(out[0:4], app)
	out[4] = protocol
	return out
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func TestPaddingIsNotContent(t *testing.T) {
	padding := recordBytes(6, 99, []byte("padding-must-not-be-delivered"), nil)
	input := concat(
		recordBytes(6, 7, []byte("abc"), padding),
		recordBytes(7, 7, []byte("def"), nil),
	)

	dec := dataeng.NewDecoder(128)
	if err := dec.Push(input); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := dec.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	got := dec.Outputs()
	if len(got) != 2 {
		t.Fatalf("got %d output records, want 2", len(got))
	}
	if got[0].Type != 6 || got[0].Request != 7 || string(got[0].Content) != "abc" {
		t.Fatalf("first record = %#v", got[0])
	}
	if got[1].Type != 7 || got[1].Request != 7 || string(got[1].Content) != "def" {
		t.Fatalf("second record = %#v", got[1])
	}
	for _, rec := range got {
		if bytes.Contains(rec.Content, padding) {
			t.Fatalf("padding leaked into content: %q", rec.Content)
		}
	}
}

func TestZeroLengthType6IsDeliveredAsStreamEnd(t *testing.T) {
	dec := dataeng.NewDecoder(16)
	input := concat(
		recordBytes(6, 3, nil, nil),
		recordBytes(7, 4, []byte("next"), nil),
	)
	if err := dec.Push(input); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := dec.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	got := dec.Outputs()
	if len(got) != 2 {
		t.Fatalf("got %d output records, want the end marker and the next record", len(got))
	}
	rec := got[0]
	if rec.Type != 6 || rec.Request != 3 {
		t.Fatalf("record = %#v, want type 6 request 3", rec)
	}
	if len(rec.Content) != 0 {
		t.Fatalf("end marker content length = %d, want 0", len(rec.Content))
	}
	if !rec.IsOutputEnd() {
		t.Fatal("zero-length type 6 record was not recognised as stream end")
	}
	if got[1].Type != 7 || got[1].Request != 4 || string(got[1].Content) != "next" {
		t.Fatalf("record after end marker = %#v", got[1])
	}
}

func TestZeroLengthType6WithPaddingIsStillDelivered(t *testing.T) {
	dec := dataeng.NewDecoder(16)
	input := recordBytes(6, 4, nil, []byte("pad"))
	if err := dec.Push(input); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := dec.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	got := dec.Outputs()
	if len(got) != 1 {
		t.Fatalf("got %d output records, want 1", len(got))
	}
	if len(got[0].Content) != 0 {
		t.Fatalf("padding became content: %q", got[0].Content)
	}
}

func TestZeroLengthType7IsAlsoDelivered(t *testing.T) {
	dec := dataeng.NewDecoder(16)
	if err := dec.Push(recordBytes(7, 5, nil, nil)); err != nil {
		t.Fatalf("Push: %v", err)
	}
	got := dec.Outputs()
	if len(got) != 1 || got[0].Type != 7 || len(got[0].Content) != 0 {
		t.Fatalf("got %#v, want one empty type 7 record", got)
	}
}

func TestType6AfterClosedRequestFailsAndKeepsRecords(t *testing.T) {
	dec := dataeng.NewDecoder(64)
	first := recordBytes(6, 11, []byte("before"), nil)
	closeRecord := recordBytes(3, 11, statusBytes(9, 2), nil)
	late := recordBytes(6, 11, []byte("after-close"), nil)

	if err := dec.Push(first); err != nil {
		t.Fatalf("Push first: %v", err)
	}
	if err := dec.Push(closeRecord); err != nil {
		t.Fatalf("Push close: %v", err)
	}
	if err := dec.Push(late); !errors.Is(err, dataeng.ErrRequestClosed) {
		t.Fatalf("Push after close error = %v, want ErrRequestClosed", err)
	}
	if err := dec.Push(recordBytes(6, 12, []byte("other"), nil)); err == nil {
		t.Fatal("decoder accepted input after a failure")
	}
	if err := dec.Finish(); err == nil {
		t.Fatal("Finish succeeded after a failure")
	}

	got := dec.Records()
	if len(got) != 2 {
		t.Fatalf("got %d retained records, want output plus close record", len(got))
	}
	if string(got[0].Content) != "before" || got[0].Type != 6 || got[0].Request != 11 {
		t.Fatalf("retained output changed: %#v", got[0])
	}
	if got[1].Type != 3 || got[1].Request != 11 {
		t.Fatalf("retained close record = %#v", got[1])
	}
	if got[1].AppStatus != 9 || got[1].ProtocolStatus != 2 {
		t.Fatalf("status = (%d, %d), want (9, 2)", got[1].AppStatus, got[1].ProtocolStatus)
	}
}

func TestHeaderCanBeSplitAnywhere(t *testing.T) {
	input := recordBytes(6, 21, []byte("split-header"), []byte("pad"))
	dec := dataeng.NewDecoder(64)

	prev := 0
	for _, end := range []int{1, 3, 5, 6, 7, 8} {
		start := prev
		if err := dec.Push(input[start:end]); err != nil {
			t.Fatalf("Push header bytes [%d:%d]: %v", start, end, err)
		}
		prev = end
	}
	if err := dec.Push(input[8:]); err != nil {
		t.Fatalf("Push body: %v", err)
	}
	if err := dec.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	got := dec.Outputs()
	if len(got) != 1 || string(got[0].Content) != "split-header" {
		t.Fatalf("got %#v", got)
	}
}

func TestPushCanStopInContentAndPadding(t *testing.T) {
	content := []byte("0123456789")
	padding := []byte("PADDING")
	input := recordBytes(7, 31, content, padding)
	dec := dataeng.NewDecoder(64)

	// Header plus part of content.
	if err := dec.Push(input[:12]); err != nil {
		t.Fatalf("Push header and partial content: %v", err)
	}
	// Finish content, stop before padding.
	if err := dec.Push(input[12 : 8+len(content)]); err != nil {
		t.Fatalf("Push rest of content: %v", err)
	}
	if len(dec.Outputs()) != 0 {
		t.Fatal("record was delivered before its padding was consumed")
	}
	if err := dec.Push(input[8+len(content) : 8+len(content)+3]); err != nil {
		t.Fatalf("Push partial padding: %v", err)
	}
	if len(dec.Outputs()) != 0 {
		t.Fatal("record was delivered with padding still pending")
	}
	if err := dec.Push(input[8+len(content)+3:]); err != nil {
		t.Fatalf("Push rest of padding: %v", err)
	}
	if err := dec.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	got := dec.Outputs()
	if len(got) != 1 {
		t.Fatalf("got %d records, want 1", len(got))
	}
	if !bytes.Equal(got[0].Content, content) {
		t.Fatalf("content = %q, want %q", got[0].Content, content)
	}
}

func TestMaxContentRejectedWhenLengthFieldBecomesReadable(t *testing.T) {
	dec := dataeng.NewDecoder(8)
	header := make([]byte, 8)
	header[0] = 1
	header[1] = 6
	binary.BigEndian.PutUint16(header[2:4], 40)
	binary.BigEndian.PutUint16(header[4:6], 9) // exceeds maxContent
	header[7] = 0

	if err := dec.Push(header[:6]); !errors.Is(err, dataeng.ErrMaxContent) {
		t.Fatalf("error = %v, want ErrMaxContent after length field", err)
	}
	if err := dec.Push(header[6:]); !errors.Is(err, dataeng.ErrMaxContent) {
		t.Fatalf("error after more header bytes = %v, want sticky ErrMaxContent", err)
	}
	if len(dec.Records()) != 0 {
		t.Fatalf("oversized record was delivered: %#v", dec.Records())
	}

	// The limit itself is allowed.
	ok := dataeng.NewDecoder(8)
	if err := ok.Push(recordBytes(6, 41, []byte("12345678"), nil)); err != nil {
		t.Fatalf("Push at limit: %v", err)
	}
	if got := ok.Outputs(); len(got) != 1 || string(got[0].Content) != "12345678" {
		t.Fatalf("record at limit = %#v", got)
	}
}

func TestFinishRejectsIncompleteRecord(t *testing.T) {
	input := recordBytes(6, 51, []byte("incomplete"), nil)
	dec := dataeng.NewDecoder(64)
	if err := dec.Push(input[:9]); err != nil {
		t.Fatalf("Push partial: %v", err)
	}
	if err := dec.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
		t.Fatalf("Finish error = %v, want ErrIncomplete", err)
	}
	if err := dec.Push(input[9:]); err == nil {
		t.Fatal("Push succeeded after failed Finish")
	}
	if len(dec.Records()) != 0 {
		t.Fatalf("partial record was delivered: %#v", dec.Records())
	}
}

func TestFinishRejectsPartialHeaderAndPadding(t *testing.T) {
	headerOnly := make([]byte, 8)
	headerOnly[0] = 1
	headerOnly[1] = 6
	binary.BigEndian.PutUint16(headerOnly[2:4], 52)

	dec := dataeng.NewDecoder(64)
	if err := dec.Push(headerOnly[:4]); err != nil {
		t.Fatalf("Push partial header: %v", err)
	}
	if err := dec.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
		t.Fatalf("Finish partial header error = %v, want ErrIncomplete", err)
	}

	padded := recordBytes(6, 53, []byte("x"), []byte("padding"))
	dec = dataeng.NewDecoder(64)
	if err := dec.Push(padded[:8+1+3]); err != nil {
		t.Fatalf("Push partial padding: %v", err)
	}
	if err := dec.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
		t.Fatalf("Finish partial padding error = %v, want ErrIncomplete", err)
	}
}

func TestFinishAllowsEmptyAndCompleteInput(t *testing.T) {
	empty := dataeng.NewDecoder(8)
	if err := empty.Finish(); err != nil {
		t.Fatalf("Finish empty: %v", err)
	}

	complete := dataeng.NewDecoder(8)
	if err := complete.Push(recordBytes(6, 61, nil, nil)); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := complete.Finish(); err != nil {
		t.Fatalf("Finish complete: %v", err)
	}
}

func TestInvalidHeaderFields(t *testing.T) {
	status := statusBytes(1, 1)
	tests := []struct {
		name string
		rec  []byte
		want error
	}{
		{
			name: "version",
			rec: func() []byte {
				r := recordBytes(6, 70, []byte("x"), nil)
				r[0] = 2
				return r
			}(),
			want: dataeng.ErrInvalidVersion,
		},
		{
			name: "type",
			rec:  recordBytes(5, 71, []byte("x"), nil),
			want: dataeng.ErrInvalidType,
		},
		{
			name: "reserved",
			rec: func() []byte {
				r := recordBytes(6, 72, []byte("x"), nil)
				r[7] = 1
				return r
			}(),
			want: dataeng.ErrReserved,
		},
		{
			name: "short status content",
			rec:  recordBytes(3, 73, status[:7], nil),
			want: dataeng.ErrStatusLength,
		},
		{
			name: "long status content",
			rec:  recordBytes(3, 74, append(status, 0xff), nil),
			want: dataeng.ErrStatusLength,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dec := dataeng.NewDecoder(128)
			err := dec.Push(tt.rec)
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
			if !dec.Failed() {
				t.Fatal("decoder did not stop after a failure")
			}
		})
	}
}

func TestType6And7MayInterleaveForSameRequest(t *testing.T) {
	input := concat(
		recordBytes(6, 81, []byte("a"), nil),
		recordBytes(7, 81, []byte("b"), nil),
		recordBytes(6, 82, []byte("c"), nil),
		recordBytes(7, 81, []byte("d"), nil),
	)

	dec := dataeng.NewDecoder(32)
	if err := dec.Push(input); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := dec.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	got := dec.Outputs()
	wantTypes := []uint8{6, 7, 6, 7}
	wantRequests := []uint16{81, 81, 82, 81}
	wantContent := []string{"a", "b", "c", "d"}
	if len(got) != len(wantTypes) {
		t.Fatalf("got %d records, want %d", len(got), len(wantTypes))
	}
	for i := range got {
		if got[i].Type != wantTypes[i] || got[i].Request != wantRequests[i] ||
			string(got[i].Content) != wantContent[i] {
			t.Fatalf("record %d = %#v", i, got[i])
		}
	}
}

func TestRecordsBeforeFailureAreRetainedInSamePush(t *testing.T) {
	bad := recordBytes(6, 90, []byte("unused"), nil)
	bad[1] = 9
	input := concat(recordBytes(6, 91, []byte("kept"), nil), bad)

	dec := dataeng.NewDecoder(32)
	if err := dec.Push(input); !errors.Is(err, dataeng.ErrInvalidType) {
		t.Fatalf("Push error = %v, want ErrInvalidType", err)
	}
	got := dec.Outputs()
	if len(got) != 1 || string(got[0].Content) != "kept" {
		t.Fatalf("retained records = %#v", got)
	}
}

func TestDeliveredContentDoesNotAliasInput(t *testing.T) {
	input := recordBytes(6, 95, []byte("original"), []byte("pad"))
	dec := dataeng.NewDecoder(32)
	if err := dec.Push(input); err != nil {
		t.Fatalf("Push: %v", err)
	}
	for i := 8; i < 8+len("original"); i++ {
		input[i] = 'X'
	}
	got := dec.Outputs()
	if len(got) != 1 || string(got[0].Content) != "original" {
		t.Fatalf("content aliases caller input: %#v", got)
	}
}

func TestOnRecordReceivesDeliveredRecords(t *testing.T) {
	dec := dataeng.NewDecoder(32)
	var got []dataeng.Record
	dec.OnRecord(func(rec dataeng.Record) {
		got = append(got, rec)
	})
	if err := dec.Push(recordBytes(6, 100, nil, []byte("pad"))); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("callback got %d records, want 1", len(got))
	}
	if !got[0].IsOutputEnd() || got[0].Request != 100 {
		t.Fatalf("callback record = %#v", got[0])
	}
}
