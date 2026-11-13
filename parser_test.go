package dataeng_test

import (
	"bytes"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"example.org/dataeng/q0079"
)

type chunkReader struct {
	chunks [][]byte
}

func (r *chunkReader) Read(p []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	chunk := r.chunks[0]
	r.chunks = r.chunks[1:]
	n := copy(p, chunk)
	return n, nil
}

type errorReader struct {
	data []byte
	err  error
	done bool
}

func (r *errorReader) Read(p []byte) (int, error) {
	if r.done {
		return 0, r.err
	}
	r.done = true
	n := copy(p, r.data)
	return n, nil
}

func splitEvery(data []byte, size int) [][]byte {
	var chunks [][]byte
	for len(data) > 0 {
		n := size
		if n > len(data) {
			n = len(data)
		}
		chunks = append(chunks, append([]byte(nil), data[:n]...))
		data = data[n:]
	}
	return chunks
}

func collect(t *testing.T, p *dataeng.Parser) []dataeng.Event {
	t.Helper()
	var events []dataeng.Event
	for {
		event, err := p.Next()
		if errors.Is(err, io.EOF) {
			return events
		}
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		events = append(events, event)
	}
}

func TestChunkedUTF8CRLFAndFields(t *testing.T) {
	stream := []byte("id: 7\r\nevent: greeting\r\ndata: 你好，世界\r\ndata: second line\r\n\r\n")
	reader := &chunkReader{chunks: splitEvery(stream, 1)}

	events := collect(t, dataeng.NewParser(reader))
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}

	got := events[0]
	if got.Type != "greeting" {
		t.Errorf("Type = %q, want %q", got.Type, "greeting")
	}
	if got.Data != "你好，世界\nsecond line" {
		t.Errorf("Data = %q, want %q", got.Data, "你好，世界\nsecond line")
	}
	if got.ID != "7" {
		t.Errorf("ID = %q, want %q", got.ID, "7")
	}
	if got.Sequence != 1 {
		t.Errorf("Sequence = %d, want 1", got.Sequence)
	}
}

func TestCRLFAndCRLineEndings(t *testing.T) {
	tests := []struct {
		name   string
		stream string
		want   []string
	}{
		{
			name:   "lf",
			stream: "data: a\n\ndata: b\n\n",
			want:   []string{"a", "b"},
		},
		{
			name:   "crlf",
			stream: "data: a\r\n\r\ndata: b\r\n\r\n",
			want:   []string{"a", "b"},
		},
		{
			name:   "cr",
			stream: "data: a\r\rdata: b\r\r",
			want:   []string{"a", "b"},
		},
		{
			name:   "mixed",
			stream: "data: a\r\ndata: b\rdata: c\n\r\n",
			want:   []string{"a\nb\nc"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reader := &chunkReader{chunks: splitEvery([]byte(tt.stream), 1)}
			events := collect(t, dataeng.NewParser(reader))
			if len(events) != len(tt.want) {
				t.Fatalf("got %d events, want %d", len(events), len(tt.want))
			}
			for i, want := range tt.want {
				if events[i].Data != want {
					t.Errorf("event %d Data = %q, want %q", i, events[i].Data, want)
				}
			}
		})
	}
}

func TestOnlyCompleteBlankLineDispatches(t *testing.T) {
	tests := []struct {
		name   string
		stream string
		want   int
	}{
		{name: "data line only", stream: "data: a\n", want: 0},
		{name: "data line no terminator", stream: "data: a", want: 0},
		{name: "id and retry only", stream: "id: 9\nretry: 100\n", want: 0},
		{name: "one blank line", stream: "data: a\n\n", want: 1},
		{name: "lf and blank in separate chunks", stream: "data: a\n\r\n", want: 1},
		{name: "empty event body", stream: "\n", want: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reader := &chunkReader{chunks: splitEvery([]byte(tt.stream), 1)}
			events := collect(t, dataeng.NewParser(reader))
			if len(events) != tt.want {
				t.Fatalf("got %d events, want %d", len(events), tt.want)
			}
		})
	}
}

func TestDataMultilineAndWhitespace(t *testing.T) {
	stream := "data: one\ndata: two\ndata:\ndata:  four\n\n" +
		"data\n\n" +
		"data: three\n\n"

	events := collect(t, dataeng.NewParser(&chunkReader{chunks: splitEvery([]byte(stream), 2)}))
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}
	if events[0].Data != "one\ntwo\n\n four" {
		t.Errorf("first Data = %q, want %q", events[0].Data, "one\ntwo\n\n four")
	}
	if events[1].Data != "" {
		t.Errorf("second Data = %q, want empty", events[1].Data)
	}
	if events[2].Data != "three" {
		t.Errorf("third Data = %q, want %q", events[2].Data, "three")
	}
}

func TestEventIDEmptyPersistenceAndNUL(t *testing.T) {
	stream := "id: 1\ndata: a\n\n" +
		"data: b\n\n" +
		"id:\ndata: c\n\n" +
		"data: d\n\n" +
		"id: x\x00y\ndata: e\n\n" +
		"id: 2\ndata: f\n\n"

	events := collect(t, dataeng.NewParser(strings.NewReader(stream)))
	if len(events) != 6 {
		t.Fatalf("got %d events, want 6", len(events))
	}
	wantIDs := []string{"1", "1", "", "", "", "2"}
	for i, want := range wantIDs {
		if events[i].ID != want {
			t.Errorf("event %d ID = %q, want %q", i, events[i].ID, want)
		}
	}
}

func TestRetry(t *testing.T) {
	stream := "retry: 1500\ndata: a\n\n" +
		"retry: nope\ndata: b\n\n" +
		"retry: 2500  \ndata: c\n\n" +
		"retry: 3000\ndata: d\n\n"

	p := dataeng.NewParser(&chunkReader{chunks: splitEvery([]byte(stream), 3)})
	events := collect(t, p)
	if len(events) != 4 {
		t.Fatalf("got %d events, want 4", len(events))
	}
	if events[0].Retry != 1500*time.Millisecond || !events[0].RetrySet {
		t.Errorf("first Retry = %v (set %v), want 1.5s (set true)", events[0].Retry, events[0].RetrySet)
	}
	if events[1].Retry != 1500*time.Millisecond {
		t.Errorf("second Retry = %v, want 1.5s", events[1].Retry)
	}
	if events[2].Retry != 1500*time.Millisecond {
		t.Errorf("third Retry = %v, want 1.5s (invalid retry ignored)", events[2].Retry)
	}
	if events[3].Retry != 3*time.Second {
		t.Errorf("fourth Retry = %v, want 3s", events[3].Retry)
	}
	if p.Retry() != 3*time.Second || p.RetryMilliseconds() != 3000 {
		t.Errorf("parser Retry = %v/%d, want 3s/3000", p.Retry(), p.RetryMilliseconds())
	}
}

func TestCommitControlsLastEventID(t *testing.T) {
	stream := "id: 1\ndata: a\n\nid: 1\ndata: b\n\nid:\ndata: c\n\n"
	p := dataeng.NewParser(strings.NewReader(stream))

	first, err := p.Next()
	if err != nil {
		t.Fatal(err)
	}
	if p.LastEventID() != "" {
		t.Fatalf("LastEventID before commit = %q, want empty", p.LastEventID())
	}
	if err := p.Commit(first); err != nil {
		t.Fatal(err)
	}
	if p.LastEventID() != "1" {
		t.Errorf("LastEventID = %q, want 1", p.LastEventID())
	}

	second, err := p.Next()
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != "1" || second.Sequence != 2 {
		t.Errorf("second event = %+v, want duplicate id with sequence 2", second)
	}
	if err := p.Commit(second); err != nil {
		t.Fatal(err)
	}
	if err := p.Commit(first); !errors.Is(err, dataeng.ErrOutOfOrderCommit) {
		t.Errorf("Commit(old) error = %v, want ErrOutOfOrderCommit", err)
	}
	if p.CommittedSequence() != 2 {
		t.Errorf("CommittedSequence = %d, want 2", p.CommittedSequence())
	}

	third, err := p.Next()
	if err != nil {
		t.Fatal(err)
	}
	if third.ID != "" {
		t.Errorf("third ID = %q, want empty", third.ID)
	}
	if err := p.Commit(); err != nil {
		t.Fatal(err)
	}
	if p.LastEventID() != "" {
		t.Errorf("LastEventID after empty id commit = %q, want empty", p.LastEventID())
	}
}

func TestDuplicateIDsPreserveArrivalOrder(t *testing.T) {
	stream := "id: same\ndata: a\n\nid: same\ndata: b\n\nid: same\ndata: c\n\n"
	events := collect(t, dataeng.NewParser(strings.NewReader(stream)))
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}
	for i, event := range events {
		if event.ID != "same" {
			t.Errorf("event %d ID = %q, want same", i, event.ID)
		}
		if event.Sequence != uint64(i+1) {
			t.Errorf("event %d Sequence = %d, want %d", i, event.Sequence, i+1)
		}
	}
	if events[0].Data != "a" || events[1].Data != "b" || events[2].Data != "c" {
		t.Errorf("arrival order not preserved: %q %q %q", events[0].Data, events[1].Data, events[2].Data)
	}
}

func TestReadErrorDiscardsPartialEvent(t *testing.T) {
	reader := &errorReader{
		data: []byte("id: 1\ndata: complete\n\nid: 2\ndata: partial\n"),
		err:  io.ErrUnexpectedEOF,
	}
	p := dataeng.NewParser(reader)

	event, err := p.Next()
	if err != nil {
		t.Fatalf("first Next: %v", err)
	}
	if event.Data != "complete" || event.ID != "1" {
		t.Fatalf("unexpected event: %+v", event)
	}

	if _, err := p.Next(); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("second Next error = %v, want ErrUnexpectedEOF", err)
	}
	if p.DiscardedEvents() != 1 {
		t.Errorf("DiscardedEvents = %d, want 1", p.DiscardedEvents())
	}
	if p.PendingEventID() != "1" {
		t.Errorf("PendingEventID = %q, want rolled back to 1", p.PendingEventID())
	}
	if p.LastEventID() != "" {
		t.Errorf("LastEventID = %q, want empty", p.LastEventID())
	}

	if err := p.Commit(event); err != nil {
		t.Fatal(err)
	}
	if p.LastEventID() != "1" {
		t.Errorf("LastEventID after commit = %q, want 1", p.LastEventID())
	}
}

func TestEOFDropsHalfEvent(t *testing.T) {
	p := dataeng.NewParser(strings.NewReader("id: 4\ndata: half\n"))
	if _, err := p.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("Next error = %v, want EOF", err)
	}
	if p.LastEventID() != "" {
		t.Errorf("LastEventID = %q, want empty", p.LastEventID())
	}
	if p.DiscardedEvents() != 1 {
		t.Errorf("DiscardedEvents = %d, want 1", p.DiscardedEvents())
	}
}

func TestFeedAcrossArbitraryChunks(t *testing.T) {
	stream := []byte("retry: 1200\r\nid: 10\r\ndata: 第一行\r\ndata: 第二行\r\n\r\n" +
		"id: 11\rdata: next\r\r")
	p := dataeng.NewParser()

	var events []dataeng.Event
	for _, chunk := range splitEvery(stream, 3) {
		events = append(events, p.Feed(chunk)...)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
	if events[0].Data != "第一行\n第二行" || events[0].ID != "10" {
		t.Errorf("first event: %+v", events[0])
	}
	if events[1].Data != "next" || events[1].ID != "11" {
		t.Errorf("second event: %+v", events[1])
	}
	if events[0].Retry != 1200*time.Millisecond {
		t.Errorf("Retry = %v, want 1.2s", events[0].Retry)
	}
}

func TestBOMSplitAcrossChunks(t *testing.T) {
	stream := append([]byte{0xEF, 0xBB, 0xBF}, []byte("data: hello\n\n")...)
	p := dataeng.NewParser()

	var events []dataeng.Event
	for _, b := range stream {
		events = append(events, p.Feed([]byte{b})...)
	}
	if len(events) != 1 || events[0].Data != "hello" {
		t.Fatalf("events = %+v, want one hello event", events)
	}
}

func TestCommentsAndUnknownFieldsIgnored(t *testing.T) {
	stream := ": keep-alive\nfoo: bar\ndata: value\nevent:\n\n"
	events := collect(t, dataeng.NewParser(strings.NewReader(stream)))
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	if events[0].Type != "message" {
		t.Errorf("Type = %q, want message", events[0].Type)
	}
	if events[0].Data != "value" {
		t.Errorf("Data = %q, want value", events[0].Data)
	}
}

func TestLargeDataLine(t *testing.T) {
	large := strings.Repeat("x", 128*1024)
	stream := "data: " + large + "\n\n"
	events := collect(t, dataeng.NewParser(&chunkReader{chunks: splitEvery([]byte(stream), 1000)}))
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	if !bytes.Equal([]byte(events[0].Data), []byte(large)) {
		t.Errorf("large data mismatch: got %d bytes, want %d", len(events[0].Data), len(large))
	}
}

func TestImmediateEventOnCompleteBlankLineAtEOF(t *testing.T) {
	// A lone CR is itself a complete line ending in SSE.
	events := collect(t, dataeng.NewParser(strings.NewReader("data: x\r\r")))
	if len(events) != 1 || events[0].Data != "x" {
		t.Fatalf("events = %+v, want one x event", events)
	}
}

func TestAliasesAndExplicitCommitID(t *testing.T) {
	p := dataeng.New(strings.NewReader("id: 1\ndata: hello\n\n"))
	event, err := p.ReadEvent()
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Confirm(event); err != nil {
		t.Fatal(err)
	}
	if p.CommittedID() != "1" {
		t.Errorf("CommittedID = %q, want 1", p.CommittedID())
	}
	p.CommitID("explicit")
	if p.LastEventID() != "explicit" {
		t.Errorf("LastEventID = %q, want explicit", p.LastEventID())
	}
	if err := p.Finish(); err != nil {
		t.Fatal(err)
	}
}

func TestAnyChunkBoundaryProducesSameEvents(t *testing.T) {
	streams := []string{
		"data: 你好\ndata: 世界\n\n",
		"id: 1\r\ndata: a\r\n\r\nid: 2\rdata: b\r\r",
		": comment\r\nevent: update\rdata: one\r\ndata: two\r\n\r\n",
		"id:\ndata: empty id\n\nretry: 1500\ndata: after retry\n\n",
		"data: no blank line\n",
		"id: x\r",
	}

	for _, stream := range streams {
		data := []byte(stream)
		want := feedAll(data, len(data))
		for size := 1; size <= len(data); size++ {
			if got := feedAll(data, size); !reflect.DeepEqual(got, want) {
				t.Fatalf("stream %q with chunk size %d:\n got %+v\nwant %+v", stream, size, got, want)
			}
		}
	}
}

func feedAll(data []byte, size int) []dataeng.Event {
	p := dataeng.NewParser()
	var events []dataeng.Event
	for _, chunk := range splitEvery(data, size) {
		events = append(events, p.Feed(chunk)...)
	}
	_ = p.Close()
	return events
}
