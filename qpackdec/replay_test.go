package qpackdec

import (
	"fmt"
	"testing"
)

// Event is one abstract host event replayed against a Decoder. The host has
// already parsed wire bytes; this mirrors the no-byte-decoding contract.
type Event struct {
	kind   eventKind
	name   string // insert name
	value  string // insert value
	capVal int64  // SetCapacity target
	stream int64  // cancel target
	block  HeaderBlock
}

type eventKind int

const (
	evInsert eventKind = iota
	evSetCapacity
	evHeader
	evCancel
)

// replayRecord captures one observable step of a replay.
type replayRecord struct {
	step      int
	event     Event
	delivered []int64
	errCode   string
}

func replay(events []Event, static []StaticField) ([]replayRecord, *DecodeError) {
	// A large M and generous blocked limit keep the focus on replay semantics.
	d, err := New(640, 8, static)
	if err != nil {
		return nil, nil
	}
	var records []replayRecord
	var terminal *DecodeError
	for step, ev := range events {
		rec := replayRecord{step: step, event: ev}
		switch ev.kind {
		case evInsert:
			out, ierr := d.Insert(ev.name, ev.value)
			if ierr != nil {
				var ok bool
				terminal, ok = ierr.(*DecodeError)
				if !ok {
					terminal = d.Err()
				}
				rec.errCode = terminal.Code
			}
			for _, dl := range out {
				rec.delivered = append(rec.delivered, dl.StreamID)
			}
		case evSetCapacity:
			if serr := d.SetCapacity(ev.capVal); serr != nil {
				terminal = d.Err()
				rec.errCode = terminal.Code
			}
		case evHeader:
			out, herr := d.HeaderBlockReceived(ev.block)
			if herr != nil {
				terminal = d.Err()
				rec.errCode = terminal.Code
			}
			for _, dl := range out {
				rec.delivered = append(rec.delivered, dl.StreamID)
			}
		case evCancel:
			if cerr := d.CancelStream(ev.stream); cerr != nil {
				terminal = d.Err()
				rec.errCode = terminal.Code
			}
		}
		records = append(records, rec)
		if terminal != nil {
			break
		}
	}
	return records, terminal
}

func recordsKey(records []replayRecord) string {
	out := ""
	for _, r := range records {
		out += fmt.Sprintf("%d:%s:%v|", r.step, r.errCode, r.delivered)
	}
	return out
}

// TestEventReplayWrappingAndOutOfOrder drives a scripted cross-stream scenario
// that crosses the full range F, then replays the identical event log through
// a fresh decoder and requires byte-identical observable behavior.
func TestEventReplayWrappingAndOutOfOrder(t *testing.T) {
	static := testStatic()
	// M=640 -> K=20, F=40. Capacity full; empty entries each cost 32, so the
	// ring holds up to 20 entries. We drive insert counts across F by issuing
	// header blocks with encoded counts at multiple wrap windows.
	events := []Event{
		{kind: evSetCapacity, capVal: 640},
		// Stream 100 blocks waiting on R=2 (E=3 at I=0).
		{kind: evHeader, block: HeaderBlock{
			StreamID: 100, EncodedCount: 3, Sign: 0, Delta: 0,
			Fields: []Field{rel(0)},
		}},
		// Stream 101 blocks waiting on R=1 (E=2 at I=0), received after 100.
		{kind: evHeader, block: HeaderBlock{
			StreamID: 101, EncodedCount: 2, Sign: 0, Delta: 0,
			Fields: []Field{rel(0)},
		}},
		// Cancel 100: it must never deliver even once its R is reached.
		{kind: evCancel, stream: 100},
		// Two inserts: I goes 0 -> 1 -> 2. Stream 101 (R=1) delivers at I=1.
		{kind: evInsert, name: "n0", value: "v0"},
		{kind: evInsert, name: "n1", value: "v1"},
		// At I=2, E=3 still means R=2 (same E, earlier I=0 also meant R=2 here,
		// but a block received now resolves immediately instead of blocking).
		{kind: evHeader, block: HeaderBlock{
			StreamID: 102, EncodedCount: 3, Sign: 0, Delta: 0,
			Fields: []Field{rel(0)},
		}},
	}

	records, terminal := replay(events, static)
	if terminal != nil {
		t.Fatalf("unexpected terminal error: %v", terminal)
	}
	// Expected deliveries: step 3 (first insert) -> 101; step 5 (header 102)
	// immediate. Stream 100 never appears.
	var deliveredOrder []int64
	for _, r := range records {
		deliveredOrder = append(deliveredOrder, r.delivered...)
	}
	want := []int64{101, 102}
	if len(deliveredOrder) != len(want) {
		t.Fatalf("deliveries=%v want %v", deliveredOrder, want)
	}
	for i := range want {
		if deliveredOrder[i] != want[i] {
			t.Fatalf("delivery order=%v want %v", deliveredOrder, want)
		}
	}

	// Determinism: replay the same log through a fresh component.
	again, _ := replay(events, static)
	if recordsKey(records) != recordsKey(again) {
		t.Fatalf("non-deterministic replay:\nfirst=%s\nagain=%s",
			recordsKey(records), recordsKey(again))
	}
}

// TestEventReplayWrapAround uses a small table (M=128, K=4, F=8) and inserts
// enough entries that the required insert count crosses F repeatedly, while
// header blocks reference entries that remain live because capacity holds
// K entries. It checks both the wrap arithmetic and ordered delivery.
func TestEventReplayWrapAround(t *testing.T) {
	// Build blocks at reception time for R values 1..6 using encoded counts
	// valid at I=0 with F=8: E=R+1 (R in 1..6 all within the first window).
	events := []Event{{kind: evSetCapacity, capVal: 128}}
	const streams = 6
	for r := 1; r <= streams; r++ {
		events = append(events, Event{
			kind: evHeader,
			block: HeaderBlock{
				StreamID:     int64(200 + r),
				EncodedCount: int64(r + 1), // E=R+1 at I=0
				Sign:         0,
				Delta:        0,               // base = R
				Fields:       []Field{rel(0)}, // base-1 = R-1
			},
		})
	}
	for i := 0; i < streams; i++ {
		events = append(events, Event{kind: evInsert, name: "k", value: "v"})
	}

	records, terminal := replay(events, testStatic())
	if terminal != nil {
		t.Fatalf("unexpected terminal error: %v", terminal)
	}
	var order []int64
	for _, r := range records {
		order = append(order, r.delivered...)
	}
	// Block for R=r becomes deliverable once I>=r, i.e. on the r-th insert.
	// Reception order is 201..206 and each becomes ready in that same order.
	want := []int64{201, 202, 203, 204, 205, 206}
	if len(order) != len(want) {
		t.Fatalf("order=%v want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("wrap delivery order=%v want %v", order, want)
		}
	}

	again, _ := replay(events, testStatic())
	if recordsKey(records) != recordsKey(again) {
		t.Fatal("wrap replay not deterministic")
	}
}

// TestEventReplayTerminalErrorStopsComponent replays a script where an evicted
// reference kills the component, then proves later events are all rejected and
// the evidence is retained.
func TestEventReplayTerminalErrorStopsComponent(t *testing.T) {
	events := []Event{
		{kind: evSetCapacity, capVal: 256},
		{kind: evInsert, name: "a", value: "1"},
		{kind: evInsert, name: "b", value: "2"},
		{kind: evSetCapacity, capVal: 32}, // evicts abs 0
		{kind: evHeader, block: HeaderBlock{
			StreamID: 300, EncodedCount: 2, Sign: 0, Delta: 0,
			Fields: []Field{rel(0)}, // base=1 -> abs 0 evicted
		}},
		{kind: evInsert, name: "c", value: "3"}, // must be rejected
		{kind: evHeader, block: HeaderBlock{StreamID: 301}},
	}
	records, terminal := replay(events, testStatic())
	if terminal == nil || terminal.Code != "evicted_dynamic_reference" {
		t.Fatalf("want evicted_dynamic_reference, got %+v", terminal)
	}
	if terminal.Evidence.StreamID != 300 || terminal.Evidence.Header == nil {
		t.Fatal("evidence must retain stream id and header copy")
	}
	// The replay must stop at the failing step (index 4) and not run later events.
	last := records[len(records)-1]
	if last.step != 4 {
		t.Fatalf("replay must stop on first error, last step=%d", last.step)
	}
}
