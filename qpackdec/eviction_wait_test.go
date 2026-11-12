package qpackdec

import "testing"

// TestReferenceEvictedWhileWaiting covers the cross-stream case where a blocked
// block's required count is eventually reached but the specific absolute entry
// it references was evicted while it waited. Pumping must raise a terminal
// connection error rather than bind the absolute index to a newer ring entry.
func TestReferenceEvictedWhileWaiting(t *testing.T) {
	// M=256, current capacity 256 -> eight 32-byte live entries; K=8, F=16.
	d, _ := New(256, 8, testStatic())
	if err := d.SetCapacity(256); err != nil {
		t.Fatal(err)
	}
	// Insert six entries (abs 0..5). I=6.
	for i := 0; i < 6; i++ {
		if _, err := d.Insert("", ""); err != nil {
			t.Fatal(err)
		}
	}
	// Freeze a block requiring R=12 that references abs 6 via relative index.
	// At I=6, find E that recovers R=12 with F=16, K=8.
	var encoded int64 = -1
	for e := int64(1); e <= 16; e++ {
		if r, ok := refRequiredInsertCount(e, 6, 256); ok && r == 12 {
			encoded = e
			break
		}
	}
	if encoded < 0 {
		t.Fatal("no encoded count recovers R=12 at I=6")
	}
	hb := HeaderBlock{
		StreamID: 1, EncodedCount: encoded, Sign: 0, Delta: 0, // base = R = 12
		Fields: []Field{rel(5)}, // base-5-1 = abs 6
	}
	if _, err := d.HeaderBlockReceived(hb); err != nil {
		t.Fatal(err)
	}
	if d.BlockedStreams() != 1 {
		t.Fatalf("blocked = %d, want 1", d.BlockedStreams())
	}

	// Shrink to 64 bytes (two live entries) while the block waits: abs 0..3
	// are evicted immediately, leaving abs 4 and 5.
	if err := d.SetCapacity(64); err != nil {
		t.Fatal(err)
	}

	// Drive inserts up to R=12. The two-slot window keeps only the newest two
	// entries, so the referenced abs 6 is long evicted by the time the block
	// pumps. The component must fail on the insertion that first satisfies R.
	// From I=6, six more insertions reach I=12 and satisfy R; the final insert
	// runs the pump that observes the evicted abs 6.
	var sawError error
	for i := 0; i < 6; i++ {
		if _, err := d.Insert("", ""); err != nil {
			sawError = err
			break
		}
	}
	if sawError == nil {
		t.Fatal("pump must fail once the waited-for entry was evicted")
	}
	if d.Err() == nil || d.Err().Code != "evicted_dynamic_reference" {
		t.Fatalf("want evicted_dynamic_reference, got %+v", d.Err())
	}
}
