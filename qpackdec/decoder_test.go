package qpackdec

import "testing"

func testStatic() []StaticField {
	return []StaticField{
		{Name: ":path", Value: "/"},
		{Name: ":method", Value: "GET"},
	}
}

func rel(i int64) Field  { return Field{Kind: FieldRelative, Index: i} }
func post(i int64) Field { return Field{Kind: FieldPostBase, Index: i} }

func TestNewRejectsNegativeConfig(t *testing.T) {
	if _, err := New(-1, 0, nil); err == nil {
		t.Fatal("negative M must error")
	}
	if _, err := New(0, -1, nil); err == nil {
		t.Fatal("negative blocked limit must error")
	}
	d, err := New(0, 0, testStatic())
	if err != nil {
		t.Fatal(err)
	}
	if d.MaxCapacity() != 0 || d.CurrentCapacity() != 0 || d.InsertCount() != 0 {
		t.Fatal("decoder must start with zero capacity and zero inserts")
	}
}

func TestZeroCapacityStaticAndLiteralBlock(t *testing.T) {
	d, _ := New(0, 0, testStatic())
	hb := HeaderBlock{
		StreamID:     42,
		EncodedCount: 0,
		Sign:         0,
		Delta:        0,
		Fields: []Field{
			{Kind: FieldStatic, Index: 1},
			{Kind: FieldLiteral, Name: "x", Value: "y"},
		},
	}
	out, err := d.HeaderBlockReceived(hb)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].StreamID != 42 || len(out[0].Header.Fields) != 2 {
		t.Fatalf("bad delivery: %+v", out)
	}
	got := out[0].Header.Fields
	if got[0].Source != SourceStatic || got[0].StaticIndex != 1 || got[0].Name != ":method" {
		t.Fatalf("static field wrong: %+v", got[0])
	}
	if got[1].Source != SourceLiteral || got[1].Name != "x" || got[1].DynamicIndex != -1 {
		t.Fatalf("literal field wrong: %+v", got[1])
	}
	// Non-zero E is impossible when K=0.
	bad := hb
	bad.EncodedCount = 1
	if _, err := d.HeaderBlockReceived(bad); err == nil {
		t.Fatal("E>0 with zero capacity must be a connection error")
	}
	if d.Err() == nil {
		t.Fatal("decoder must retain terminal error")
	}
}

func TestCrossStreamWaitReceptionOrderAndFrozenE(t *testing.T) {
	// M=320, K=10, F=20. Capacity set to full.
	d, _ := New(320, 4, testStatic())
	if err := d.SetCapacity(320); err != nil {
		t.Fatal(err)
	}

	// Block stream 1 needing R=2 (E=3 at I=0 -> R=2), base 2 (S=0, delta 0),
	// referencing abs 1 (relative i=0 -> base-1).
	hb1 := HeaderBlock{
		StreamID: 1, EncodedCount: 3, Sign: 0, Delta: 0,
		Fields: []Field{rel(0)},
	}
	if out, err := d.HeaderBlockReceived(hb1); err != nil || out != nil {
		t.Fatalf("stream 1 should block: out=%v err=%v", out, err)
	}
	// Block stream 2 needing R=1 (E=2 at I=0 -> R=1), referencing abs 0.
	hb2 := HeaderBlock{
		StreamID: 2, EncodedCount: 2, Sign: 0, Delta: 0,
		Fields: []Field{rel(0)},
	}
	if _, err := d.HeaderBlockReceived(hb2); err != nil {
		t.Fatal(err)
	}
	if d.BlockedStreams() != 2 {
		t.Fatalf("blocked = %d", d.BlockedStreams())
	}

	// First insertion reaches I=1: stream 2 (R=1) is first ready but stream 1
	// (R=2) still waits. Reception order is preserved by the queue.
	out, err := d.Insert("n0", "v0")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].StreamID != 2 {
		t.Fatalf("only stream 2 should be delivered: %+v", out)
	}
	if d.BlockedStreams() != 1 {
		t.Fatalf("stream 1 must keep waiting: %d", d.BlockedStreams())
	}

	// Insert the second entry; stream 1 is now released with its frozen E=3
	// interpretation (R=2), not re-derived from the new insert count.
	out, err = d.Insert("n1", "v1")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].StreamID != 1 {
		t.Fatalf("stream 1 delivery wrong: %+v", out)
	}
	field := out[0].Header.Fields[0]
	if field.Source != SourceDynamic || field.DynamicIndex != 1 || field.Name != "n1" {
		t.Fatalf("absolute provenance wrong: %+v", field)
	}
}

func TestCancelBlockedStreamNeverDelivers(t *testing.T) {
	d, _ := New(320, 4, testStatic())
	_ = d.SetCapacity(320)
	hb := HeaderBlock{
		StreamID: 9, EncodedCount: 2, Sign: 0, Delta: 0,
		Fields: []Field{rel(0)},
	}
	if _, err := d.HeaderBlockReceived(hb); err != nil {
		t.Fatal(err)
	}
	if err := d.CancelStream(9); err != nil {
		t.Fatal(err)
	}
	if d.BlockedStreams() != 0 {
		t.Fatal("cancel must remove the blocked block")
	}
	if out, _ := d.Insert("n", "v"); len(out) != 0 {
		t.Fatalf("cancelled stream must never deliver: %+v", out)
	}
	// The id is permanently reserved.
	if _, err := d.HeaderBlockReceived(hb); err == nil {
		t.Fatal("cancelled stream id must not be reusable")
	}
	if d.Err() == nil {
		t.Fatal("id reuse is a terminal connection error")
	}
}

func TestDuplicateAndDeliveredStreamIDsRejected(t *testing.T) {
	d, _ := New(0, 0, testStatic())
	hb := HeaderBlock{StreamID: 7, Fields: []Field{{Kind: FieldStatic, Index: 0}}}
	if _, err := d.HeaderBlockReceived(hb); err != nil {
		t.Fatal(err)
	}
	if _, err := d.HeaderBlockReceived(hb); err == nil {
		t.Fatal("duplicate delivered stream id must error")
	}
	if d.Err() == nil || d.Err().Code != "stream_id_reuse" {
		t.Fatalf("expected stream_id_reuse, got %+v", d.Err())
	}
	// After a terminal error every further operation is rejected.
	if _, err := d.HeaderBlockReceived(HeaderBlock{StreamID: 8}); err == nil {
		t.Fatal("stopped component must reject further header blocks")
	}
	if err := d.SetCapacity(0); err == nil {
		t.Fatal("stopped component must reject further operations")
	}
	if _, err := d.Insert("a", "b"); err == nil {
		t.Fatal("stopped component must reject further inserts")
	}
}

func TestBlockedStreamLimitEnforced(t *testing.T) {
	d, _ := New(320, 1, testStatic())
	_ = d.SetCapacity(320)
	hb := func(id int64) HeaderBlock {
		return HeaderBlock{
			StreamID: id, EncodedCount: 2, Sign: 0, Delta: 0,
			Fields: []Field{rel(0)},
		}
	}
	if _, err := d.HeaderBlockReceived(hb(1)); err != nil {
		t.Fatal(err)
	}
	// One stream already waits; a second blocking block exceeds the limit.
	if _, err := d.HeaderBlockReceived(hb(2)); err == nil {
		t.Fatal("blocked stream limit breach must be a connection error")
	}
	if d.Err() == nil || d.Err().Code != "blocked_stream_limit_exceeded" {
		t.Fatalf("unexpected terminal state: %+v", d.Err())
	}
}

func TestShrinkInvalidatesOldReference(t *testing.T) {
	// M=256, capacity 256 holds up to 8 empty entries (32 each).
	d, _ := New(256, 2, testStatic())
	_ = d.SetCapacity(256)
	// Insert two entries, then build a block that references abs 0.
	if _, err := d.Insert("a", "1"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Insert("b", "2"); err != nil {
		t.Fatal(err)
	}
	// Shrink to 32: only the newest entry (abs 1) survives; abs 0 is evicted.
	if err := d.SetCapacity(32); err != nil {
		t.Fatal(err)
	}
	// Base 1, relative i=0 -> abs 0, which was evicted. R=1 (E=2 at I=2).
	hb := HeaderBlock{
		StreamID: 3, EncodedCount: 2, Sign: 0, Delta: 0,
		Fields: []Field{rel(0)},
	}
	_, err := d.HeaderBlockReceived(hb)
	if err == nil {
		t.Fatal("reference to an evicted entry must be a connection error")
	}
	if d.Err() == nil || d.Err().Code != "evicted_dynamic_reference" {
		t.Fatalf("unexpected: %+v", d.Err())
	}
	if d.Err().Evidence.StreamID != 3 || d.Err().Evidence.Header == nil {
		t.Fatal("error evidence must retain stream id and header copy")
	}
}

func TestRequiredCountMustMatchMaxDynamicIndex(t *testing.T) {
	d, _ := New(320, 2, testStatic())
	_ = d.SetCapacity(320)
	if _, err := d.Insert("a", "1"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Insert("b", "2"); err != nil {
		t.Fatal(err)
	}
	// Claim R=2 but only reference abs 0, so max index +1 = 1 != 2.
	hb := HeaderBlock{
		StreamID: 5, EncodedCount: 3, Sign: 0, Delta: 0, // E=3,I=2 -> R=2
		Fields: []Field{
			{Kind: FieldPostBase, Index: 0}, // base 2 -> abs 2 (not inserted yet!)
		},
	}
	// abs 2 does not exist yet, so the block waits until I>=2 already holds:
	// R=2 <= I=2, so it resolves immediately and fails on the missing entry.
	if _, err := d.HeaderBlockReceived(hb); err == nil {
		t.Fatal("reference to never-inserted abs index must error")
	}
}

func TestNoDynamicFieldsRequiresRZero(t *testing.T) {
	d, _ := New(320, 2, testStatic())
	_ = d.SetCapacity(320)
	if _, err := d.Insert("a", "1"); err != nil {
		t.Fatal(err)
	}
	hb := HeaderBlock{
		StreamID: 6, EncodedCount: 2, Sign: 0, Delta: 0, // R=1
		Fields: []Field{{Kind: FieldStatic, Index: 0}},
	}
	if _, err := d.HeaderBlockReceived(hb); err == nil {
		t.Fatal("block without dynamic refs but R!=0 must error")
	}
}

func TestPostBaseAndRelativeMapping(t *testing.T) {
	d, _ := New(320, 2, testStatic())
	_ = d.SetCapacity(320)
	for i := 0; i < 3; i++ {
		if _, err := d.Insert("k", "v"); err != nil {
			t.Fatal(err)
		}
	}
	// R=3, base chosen with sign 1: base = R - delta - 1. delta=0 -> base=2.
	// relative i=0 -> base-1 = abs 1; post-base i=0 -> base+0 = abs 2.
	hb := HeaderBlock{
		StreamID: 11, EncodedCount: 4, Sign: 1, Delta: 0, // E=4,I=3 -> R=3
		Fields: []Field{rel(0), post(0)},
	}
	out, err := d.HeaderBlockReceived(hb)
	if err != nil {
		t.Fatal(err)
	}
	got := out[0].Header.Fields
	if got[0].DynamicIndex != 1 || got[1].DynamicIndex != 2 {
		t.Fatalf("mapping wrong: %+v", got)
	}
}
