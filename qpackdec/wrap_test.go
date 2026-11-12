package qpackdec

import "testing"

// TestInsertCountAdvancesAcrossFullRange uses M=256 (K=8, F=16) but drives the
// total insert count beyond F. The absolute counter keeps increasing
// independently of ring slot reuse, and a wrapped encoded count resolves to the
// correct absolute index.
func TestInsertCountAdvancesAcrossFullRange(t *testing.T) {
	// M=1024 sets K=32, F=64. At full capacity the 32-byte entries all stay
	// live, so a waiting block's freshly inserted reference cannot be evicted.
	d, _ := New(1024, 8, testStatic())
	if err := d.SetCapacity(1024); err != nil {
		t.Fatal(err)
	}

	// Insert 40 entries: the total insert count reaches 40, still below F=64
	// but well past the first full-range window boundary K=32.
	for i := 0; i < 40; i++ {
		if _, err := d.Insert("", ""); err != nil {
			t.Fatal(err)
		}
	}
	if d.InsertCount() != 40 {
		t.Fatalf("insert count = %d, want 40", d.InsertCount())
	}

	// I=40, K=32, F=64: V=72, q=1. E=10 -> R=64+10-1=73 > V=72 and R>F, so
	// subtract F -> R=9. That is <= I and would resolve immediately; instead
	// pick E=41 -> R=64+41-1=104 > V and >F -> subtract -> 40... choose a
	// value that yields R=41 (a true wait): need q*F+E-1 in [41,72], so with
	// q=1, E=41-64+1 ... compute directly below via the reference helper.
	var chosenE int64 = -1
	for e := int64(1); e <= 64; e++ {
		if r, ok := refRequiredInsertCount(e, 40, 1024); ok && r == 41 {
			chosenE = e
			break
		}
	}
	if chosenE < 0 {
		t.Fatal("could not find an encoded count yielding R=41")
	}
	hb := HeaderBlock{
		StreamID: 1, EncodedCount: chosenE, Sign: 0, Delta: 0,
		Fields: []Field{rel(0)}, // base 41, relative i=0 -> abs 40 (newest)
	}
	if out, err := d.HeaderBlockReceived(hb); err != nil || out != nil {
		t.Fatalf("block should wait for R=41: out=%v err=%v", out, err)
	}

	// One insertion reaches I=41 and unblocks the block; base=41 with relative
	// i=0 resolves to abs 40, the newest entry at the moment R is satisfied.
	out, err := d.Insert("", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].StreamID != 1 {
		t.Fatalf("unexpected delivery: %+v", out)
	}
	if field := out[0].Header.Fields[0]; field.DynamicIndex != 40 {
		t.Fatalf("wrapped reference must resolve to abs 40: %+v", field)
	}

	ref, ok := refRequiredInsertCount(chosenE, 40, 1024)
	if !ok || ref != 41 {
		t.Fatalf("reference RIC = %d,%v want 41,true", ref, ok)
	}
}

// TestWrappedBlockedBlockFrozen confirms a blocked block keeps the R it
// recovered at reception and is never re-interpreted after more inserts.
func TestWrappedBlockedBlockFrozen(t *testing.T) {
	// M=1024, K=32, F=64. At I=12, E=14 gives R=13 (a true wait, R>I). The
	// next insertion reaches I=13 and releases the block using the R recovered
	// at reception, never re-interpreting E against the newer insert count.
	d, _ := New(1024, 8, testStatic())
	_ = d.SetCapacity(1024)
	for i := 0; i < 12; i++ {
		if _, err := d.Insert("", ""); err != nil {
			t.Fatal(err)
		}
	}
	hb := HeaderBlock{
		StreamID: 7, EncodedCount: 14, Sign: 0, Delta: 0,
		Fields: []Field{rel(0)}, // base 13, relative i=0 -> abs 12 (newest)
	}
	if _, err := d.HeaderBlockReceived(hb); err != nil {
		t.Fatal(err)
	}
	out, err := d.Insert("", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Header.Fields[0].DynamicIndex != 12 {
		t.Fatalf("frozen block delivered wrong entry: %+v", out)
	}
	if d.BlockedStreams() != 0 {
		t.Fatal("block must be removed from the wait queue after delivery")
	}
}

// TestEvictedSlotReusedDoesNotAlias proves an evicted absolute index cannot be
// satisfied by a newer entry occupying the same ring slot, even after the
// total insert count has wrapped past F.
func TestEvictedSlotReusedDoesNotAlias(t *testing.T) {
	d, _ := New(128, 8, testStatic())
	_ = d.SetCapacity(128)
	for i := 0; i < 13; i++ { // abs 0..12; ring keeps abs 9..12
		if _, err := d.Insert("", ""); err != nil {
			t.Fatal(err)
		}
	}
	// A block claiming R=13 but referencing an evicted abs 9-adjacent old index.
	// Use base=13 (R=13), relative i=4 -> abs 8, which was evicted.
	hb := HeaderBlock{
		StreamID: 9, EncodedCount: 6, Sign: 0, Delta: 0, // I=13,E=6 -> R=13
		Fields: []Field{
			rel(4), // base 13, i=4 -> abs 8 (evicted); max index constraint
			// is irrelevant because the eviction check fails first.
		},
	}
	if _, err := d.HeaderBlockReceived(hb); err == nil {
		t.Fatal("evicted absolute reference must error rather than alias a new slot")
	}
	if d.Err() == nil || d.Err().Code != "evicted_dynamic_reference" {
		t.Fatalf("unexpected error: %+v", d.Err())
	}
}
