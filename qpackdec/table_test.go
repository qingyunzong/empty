package qpackdec

import "testing"

func TestEntrySize(t *testing.T) {
	if got := entrySize("name", "value"); got != int64(4+5+32) {
		t.Fatalf("entry size = %d", got)
	}
	if got := entrySize("", ""); got != 32 {
		t.Fatalf("empty entry size = %d, want 32", got)
	}
}

func TestDynamicTableStartsEmptyZeroCapacity(t *testing.T) {
	tbl := newDynamicTable(320)
	if tbl.insertCount() != 0 || tbl.capacity != 0 || tbl.size != 0 {
		t.Fatalf("table must start empty with zero capacity: %+v", tbl)
	}
	if _, _, err := tbl.insert("a", "b"); err == nil {
		t.Fatal("insert into zero-capacity table must error")
	}
}

func TestDynamicTableInsertAbsoluteIndices(t *testing.T) {
	tbl := newDynamicTable(320)
	if err := tbl.setCapacity(320); err != nil {
		t.Fatal(err)
	}
	for want := int64(0); want < 5; want++ {
		abs, evicted, err := tbl.insert("n", "v") // size 34
		if err != nil {
			t.Fatal(err)
		}
		if abs != want || evicted != 0 {
			t.Fatalf("insert %d: abs=%d evicted=%d", want, abs, evicted)
		}
	}
	if tbl.insertCount() != 5 {
		t.Fatalf("insert count = %d", tbl.insertCount())
	}
	e, ok := tbl.lookup(3)
	if !ok || e.abs != 3 {
		t.Fatalf("lookup abs 3: %+v %v", e, ok)
	}
}

func TestDynamicTableInsertEvictsOldest(t *testing.T) {
	// M=128 -> maxEntries=4, each empty entry costs 32.
	tbl := newDynamicTable(128)
	if err := tbl.setCapacity(128); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		if _, _, err := tbl.insert("", ""); err != nil {
			t.Fatal(err)
		}
	}
	// Table is full (4*32=128). A fifth insert must evict abs 0.
	abs, evicted, err := tbl.insert("", "")
	if err != nil {
		t.Fatal(err)
	}
	if abs != 4 || evicted != 1 {
		t.Fatalf("abs=%d evicted=%d", abs, evicted)
	}
	if _, ok := tbl.lookup(0); ok {
		t.Fatal("abs 0 must be evicted")
	}
	e, ok := tbl.lookup(4)
	if !ok || e.abs != 4 {
		t.Fatal("new entry must occupy the recycled ring slot under abs 4")
	}
	if tbl.oldestAbs != 1 {
		t.Fatalf("oldest abs = %d, want 1", tbl.oldestAbs)
	}
}

func TestDynamicTableShrinkEvictsOldest(t *testing.T) {
	tbl := newDynamicTable(256)
	if err := tbl.setCapacity(256); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ { // 4 * 32 = 128 used
		if _, _, err := tbl.insert("", ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := tbl.setCapacity(96); err != nil { // keeps newest 3 (96)
		t.Fatal(err)
	}
	if tbl.used != 96 || tbl.size != 3 || tbl.oldestAbs != 1 {
		t.Fatalf("after shrink: used=%d size=%d oldest=%d", tbl.used, tbl.size, tbl.oldestAbs)
	}
	if _, ok := tbl.lookup(0); ok {
		t.Fatal("shrink must evict oldest abs 0")
	}
	if _, ok := tbl.lookup(1); !ok {
		t.Fatal("abs 1 must remain after shrink")
	}
}

func TestDynamicTableSetCapacityBounds(t *testing.T) {
	tbl := newDynamicTable(100)
	if err := tbl.setCapacity(101); err == nil {
		t.Fatal("capacity above M must error")
	}
	if err := tbl.setCapacity(-1); err == nil {
		t.Fatal("negative capacity must error")
	}
	if err := tbl.setCapacity(0); err != nil {
		t.Fatalf("shrink to zero: %v", err)
	}
	if tbl.size != 0 || tbl.used != 0 {
		t.Fatal("zero capacity must empty the table")
	}
}

func TestDynamicTableLookupNeverAliasesNewEntry(t *testing.T) {
	tbl := newDynamicTable(64) // maxEntries 2
	_ = tbl.setCapacity(64)
	for i := 0; i < 2; i++ {
		_, _, _ = tbl.insert("", "")
	}
	_, _, _ = tbl.insert("", "") // evicts abs 0, reuses slot for abs 2
	if _, ok := tbl.lookup(0); ok {
		t.Fatal("evicted abs 0 must not resolve to the new abs-2 entry in the same slot")
	}
	e, ok := tbl.lookup(2)
	if !ok || e.abs != 2 {
		t.Fatal("abs 2 lookup broken across ring wrap")
	}
}
