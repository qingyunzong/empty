package qpackdec

import "errors"

// entry is one dynamic-table entry. abs is its absolute index, which starts at
// zero and increases monotonically for the lifetime of the connection.
type entry struct {
	name  string
	value string
	abs   int64
}

// dynamicTable combines a monotonically increasing insert counter with a ring
// holding only live entries. The ring can hold at most
// maxEntries = floor(maxCapacity/32) entries because every entry costs at
// least 32 bytes (name and value may be empty). The counter keeps advancing
// after evictions and across full-range wrap boundaries, so an absolute index
// never aliases a newer entry that reuses the same ring slot.
type dynamicTable struct {
	// ring holds live entries in absolute-index order.
	ring []entry
	// head is the ring slot of the oldest live entry.
	head int
	// size is the number of live entries.
	size int
	// oldestAbs is the absolute index of the oldest live entry.
	oldestAbs int64
	// nextAbs is the absolute index assigned to the next insertion. It is the
	// total insert count and advances even when the ring is full or empty.
	nextAbs int64

	// used is the sum of entry sizes within the current capacity.
	used int64
	// capacity is the current dynamic-table capacity.
	capacity int64
	// maxCapacity is the immutable negotiated maximum capacity M.
	maxCapacity int64
}

func newDynamicTable(maxCapacity int64) *dynamicTable {
	maxEntries := maxCapacity / 32
	return &dynamicTable{
		ring:        make([]entry, int(maxEntries)),
		maxCapacity: maxCapacity,
	}
}

// entrySize implements the spec: byte length of name plus byte length of
// value plus 32.
func entrySize(name, value string) int64 {
	return int64(len(name)) + int64(len(value)) + 32
}

// evictOldest removes one oldest entry. The caller must guarantee the table is
// non-empty.
func (t *dynamicTable) evictOldest() {
	e := t.ring[t.head]
	t.used -= entrySize(e.name, e.value)
	t.ring[t.head] = entry{}
	if len(t.ring) > 0 {
		t.head = (t.head + 1) % len(t.ring)
	}
	t.size--
	t.oldestAbs++
}

// insert adds an entry, assigning it the next absolute index. It returns the
// absolute index and the number of entries evicted.
func (t *dynamicTable) insert(name, value string) (int64, int64, error) {
	size := entrySize(name, value)
	if size > t.capacity {
		return 0, 0, errors.New("entry larger than current dynamic table capacity")
	}
	evicted := int64(0)
	// A full ring must first make a free slot; the ring has only maxEntries
	// slots even when entries exceed the 32-byte minimum. Then keep evicting
	// until the byte budget also fits.
	if len(t.ring) > 0 && t.size >= len(t.ring) {
		t.evictOldest()
		evicted++
	}
	for t.used+size > t.capacity {
		t.evictOldest()
		evicted++
	}
	idx := t.nextAbs
	if len(t.ring) > 0 {
		// After eviction head points at the oldest live entry; the new entry
		// goes immediately after the live window. When the table had filled the
		// ring, eviction advanced head so this slot is the recycled oldest.
		slot := (t.head + t.size) % len(t.ring)
		t.ring[slot] = entry{name: name, value: value, abs: idx}
		t.size++
	}
	t.used += size
	advanced, ok := addChecked(t.nextAbs, 1)
	if !ok {
		return 0, 0, errors.New("absolute index overflow")
	}
	t.nextAbs = advanced
	return idx, evicted, nil
}

// setCapacity changes the current capacity, which must never exceed M. It
// evicts oldest entries until the used size fits.
func (t *dynamicTable) setCapacity(capacity int64) error {
	if capacity < 0 || capacity > t.maxCapacity {
		return errors.New("dynamic table capacity out of range")
	}
	t.capacity = capacity
	for t.size > 0 && t.used > t.capacity {
		t.evictOldest()
	}
	if t.size == 0 {
		// Keep oldestAbs aligned with nextAbs once nothing remains so a future
		// entry starts cleanly without referencing an evicted index.
		t.oldestAbs = t.nextAbs
		t.head = 0
	}
	return nil
}

// lookup returns the entry at an absolute index. ok is false when the index
// has been evicted (or never existed); a caller distinguishing the two can
// compare against nextAbs.
func (t *dynamicTable) lookup(abs int64) (entry, bool) {
	if t.size == 0 || abs < t.oldestAbs || abs >= t.nextAbs {
		return entry{}, false
	}
	if len(t.ring) == 0 {
		return entry{}, false
	}
	offset := int(abs - t.oldestAbs)
	slot := (t.head + offset) % len(t.ring)
	e := t.ring[slot]
	return e, true
}

// insertCount is the total number of inserted entries, equal to the absolute
// index of the next insertion.
func (t *dynamicTable) insertCount() int64 { return t.nextAbs }
