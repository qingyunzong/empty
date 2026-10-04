package recstream

import (
	"encoding/binary"
	"errors"
	"io"
	"reflect"
	"testing"
	"unicode/utf16"
)

func encodeUTF16(s string, bo binary.ByteOrder) []byte {
	var out []byte
	for _, u := range utf16.Encode([]rune(s)) {
		var b [2]byte
		bo.PutUint16(b[:], u)
		out = append(out, b[:]...)
	}
	return out
}

// mixedStream holds records in four encoding segments:
//
//	"héllo\n"                          UTF-8, no declaration
//	BOM-LE  "A\U0001F600\n"            UTF-16LE (incl. a surrogate pair)
//	BOM-BE  "世\n"                     UTF-16BE
//	BOM-UTF8 "done"                    UTF-8, no final terminator
func mixedStream() []byte {
	var data []byte
	data = append(data, "héllo\n"...)
	data = append(data, 0xFF, 0xFE)
	data = append(data, encodeUTF16("A\U0001F600\n", binary.LittleEndian)...)
	data = append(data, 0xFE, 0xFF)
	data = append(data, encodeUTF16("世\n", binary.BigEndian)...)
	data = append(data, 0xEF, 0xBB, 0xBF)
	data = append(data, "done"...)
	return data
}

var mixedEvents = []Event{
	{Kind: EventRune, Encoding: UTF8, Rune: 'h', Start: 0, End: 1},
	{Kind: EventRune, Encoding: UTF8, Rune: 'é', Start: 1, End: 3},
	{Kind: EventRune, Encoding: UTF8, Rune: 'l', Start: 3, End: 4},
	{Kind: EventRune, Encoding: UTF8, Rune: 'l', Start: 4, End: 5},
	{Kind: EventRune, Encoding: UTF8, Rune: 'o', Start: 5, End: 6},
	{Kind: EventRecordEnd, Encoding: UTF8, Start: 6, End: 7},
	{Kind: EventDeclaration, Encoding: UTF16LE, Start: 7, End: 9},
	{Kind: EventRune, Encoding: UTF16LE, Rune: 'A', Start: 9, End: 11},
	{Kind: EventRune, Encoding: UTF16LE, Rune: '\U0001F600', Start: 11, End: 15},
	{Kind: EventRecordEnd, Encoding: UTF16LE, Start: 15, End: 17},
	{Kind: EventDeclaration, Encoding: UTF16BE, Start: 17, End: 19},
	{Kind: EventRune, Encoding: UTF16BE, Rune: '世', Start: 19, End: 21},
	{Kind: EventRecordEnd, Encoding: UTF16BE, Start: 21, End: 23},
	{Kind: EventDeclaration, Encoding: UTF8, Start: 23, End: 26},
	{Kind: EventRune, Encoding: UTF8, Rune: 'd', Start: 26, End: 27},
	{Kind: EventRune, Encoding: UTF8, Rune: 'o', Start: 27, End: 28},
	{Kind: EventRune, Encoding: UTF8, Rune: 'n', Start: 28, End: 29},
	{Kind: EventRune, Encoding: UTF8, Rune: 'e', Start: 29, End: 30},
}

// feed decodes data in chunks of chunkSize bytes (<=0 means one single
// chunk) and returns all events.
func feed(t *testing.T, data []byte, chunkSize int) ([]Event, error) {
	t.Helper()
	d := NewDecoder()
	var events []Event
	pos := 0
	for {
		ev, err := d.Next()
		if errors.Is(err, ErrNeedMore) {
			if pos >= len(data) {
				d.Close()
				continue
			}
			n := chunkSize
			if n <= 0 || n > len(data)-pos {
				n = len(data) - pos
			}
			d.Write(data[pos : pos+n])
			pos += n
			continue
		}
		if err == io.EOF {
			return events, nil
		}
		if err != nil {
			return events, err
		}
		events = append(events, ev)
	}
}

func TestMixedStreamEvents(t *testing.T) {
	got, err := feed(t, mixedStream(), 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(got, mixedEvents) {
		t.Fatalf("events mismatch:\n got: %+v\nwant: %+v", got, mixedEvents)
	}
}

// TestArbitraryChunking feeds the mixed stream in every possible fixed chunk
// size and requires the event stream to be identical each time.
func TestArbitraryChunking(t *testing.T) {
	data := mixedStream()
	for size := 1; size <= len(data); size++ {
		got, err := feed(t, data, size)
		if err != nil {
			t.Fatalf("chunk size %d: unexpected error: %v", size, err)
		}
		if !reflect.DeepEqual(got, mixedEvents) {
			t.Fatalf("chunk size %d: events mismatch:\n got: %+v\nwant: %+v", size, got, mixedEvents)
		}
	}
}

func TestRedeclarationAtBoundary(t *testing.T) {
	data := []byte{0xFF, 0xFE, 'a', 0, 0x0A, 0, 0xFF, 0xFE, 'b', 0}
	want := []Event{
		{Kind: EventDeclaration, Encoding: UTF16LE, Start: 0, End: 2},
		{Kind: EventRune, Encoding: UTF16LE, Rune: 'a', Start: 2, End: 4},
		{Kind: EventRecordEnd, Encoding: UTF16LE, Start: 4, End: 6},
		{Kind: EventDeclaration, Encoding: UTF16LE, Start: 6, End: 8},
		{Kind: EventRune, Encoding: UTF16LE, Rune: 'b', Start: 8, End: 10},
	}
	got, err := feed(t, data, 1) // byte-by-byte also splits the BOMs
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("events mismatch:\n got: %+v\nwant: %+v", got, want)
	}
}

func TestConsecutiveDeclarations(t *testing.T) {
	data := []byte{0xEF, 0xBB, 0xBF, 0xFF, 0xFE, 0x41, 0x00}
	want := []Event{
		{Kind: EventDeclaration, Encoding: UTF8, Start: 0, End: 3},
		{Kind: EventDeclaration, Encoding: UTF16LE, Start: 3, End: 5},
		{Kind: EventRune, Encoding: UTF16LE, Rune: 'A', Start: 5, End: 7},
	}
	got, err := feed(t, data, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("events mismatch:\n got: %+v\nwant: %+v", got, want)
	}
}

func TestValidReplacementCharAccepted(t *testing.T) {
	got, err := feed(t, []byte{0xEF, 0xBF, 0xBD}, 0) // legitimately encoded U+FFFD
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []Event{{Kind: EventRune, Encoding: UTF8, Rune: '�', Start: 0, End: 3}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("events mismatch:\n got: %+v\nwant: %+v", got, want)
	}
}

var errorCases = []struct {
	name string
	data []byte
	off  int64
}{
	{"mid-record UTF-8 BOM", []byte("ab\xEF\xBB\xBFcd"), 2},
	{"mid-record UTF-16LE BOM", []byte{0xFF, 0xFE, 'a', 0, 0xFF, 0xFE}, 4},
	{"mid-record UTF-16BE BOM", []byte{0xFE, 0xFF, 0, 'a', 0xFE, 0xFF}, 4},
	{"unpaired low surrogate", []byte{0xFF, 0xFE, 0x00, 0xDC}, 2},
	{"high surrogate then ASCII", []byte{0xFF, 0xFE, 0x00, 0xD8, 0x41, 0x00}, 2},
	{"high surrogate then newline", []byte{0xFF, 0xFE, 0x00, 0xD8, 0x0A, 0x00}, 2},
	{"high surrogate then EOF", []byte{0xFF, 0xFE, 0x00, 0xD8}, 2},
	{"invalid UTF-8 byte", []byte{0xFF}, 0},
	{"overlong UTF-8", []byte{0xC0, 0x80}, 0},
	{"UTF-8 encoded surrogate", []byte{0xED, 0xA0, 0x80}, 0},
	{"truncated UTF-8 at EOF", []byte{0xE4, 0xB8}, 0},
	{"odd byte count UTF-16 at EOF", []byte{0xFF, 0xFE, 0x41}, 2},
}

func TestDecodeErrors(t *testing.T) {
	for _, tc := range errorCases {
		for _, chunk := range []int{0, 1} { // whole input and byte-by-byte
			t.Run(tc.name, func(t *testing.T) {
				_, err := feed(t, tc.data, chunk)
				var de *DecodeError
				if !errors.As(err, &de) {
					t.Fatalf("chunk %d: got %v, want *DecodeError", chunk, err)
				}
				if de.Offset != tc.off {
					t.Fatalf("chunk %d: offset = %d, want %d", chunk, de.Offset, tc.off)
				}
			})
		}
	}
}

func TestErrorIsSticky(t *testing.T) {
	d := NewDecoder()
	d.Write([]byte{0xFF})
	d.Close()
	_, err1 := d.Next()
	_, err2 := d.Next()
	if err1 == nil || err2 == nil || err1.Error() != err2.Error() {
		t.Fatalf("expected sticky error, got %v then %v", err1, err2)
	}
}
