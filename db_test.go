package dedup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPersistAndReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wal")
	db, err := Open(path, 128)
	if err != nil {
		t.Fatal(err)
	}
	if d, err := db.Apply("A", 1, Put("k1", "v1")); err != nil || d != New {
		t.Fatalf("apply = %v, %v", d, err)
	}
	if d, err := db.Apply("A", 3, Put("k3", "v3")); err != nil || d != New {
		t.Fatalf("apply = %v, %v", d, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db2, err := Open(path, 128)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	if d, err := db2.Apply("A", 1, Put("k1", "STALE")); err != nil || d != Duplicate {
		t.Fatalf("after reopen apply = %v, %v, want duplicate", d, err)
	}
	if v, ok := db2.Get("k1"); !ok || v != "v1" {
		t.Fatalf("k1 = %q, %v, want v1", v, ok)
	}
	if v, ok := db2.Get("k3"); !ok || v != "v3" {
		t.Fatalf("k3 = %q, %v, want v3", v, ok)
	}
}

func TestDuplicateAndTooOldApplyNoEffect(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "wal"), 128)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.Apply("A", 100, Put("x", "first"))
	if d, _ := db.Apply("A", 100, Put("x", "second")); d != Duplicate {
		t.Fatalf("dup = %v", d)
	}
	// 100-1 = 99 < 128: still inside the window, so this hole fill is new.
	if d, _ := db.Apply("A", 1, Put("y", "hole")); d != New {
		t.Fatalf("in-window hole fill = %v, want new", d)
	}
	if d, _ := db.Apply("A", 1000, Put("z", "jump")); d != New {
		t.Fatalf("jump = %v", d)
	}
	if d, _ := db.Apply("A", 100, Put("x", "third")); d != TooOld { // 1000-100 = 900 >= 128
		t.Fatalf("aged out = %v, want too-old", d)
	}
	if d, _ := db.Apply("A", 1, Put("y", "aged")); d != TooOld {
		t.Fatalf("aged hole = %v, want too-old", d)
	}
	if v, _ := db.Get("x"); v != "first" {
		t.Fatalf("x = %q, want first (no duplicate effect)", v)
	}
	if v, _ := db.Get("y"); v != "hole" {
		t.Fatalf("y = %q, want hole (aged-out rewrite must not apply)", v)
	}
}

func TestTornTailRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wal")
	db, err := Open(path, 128)
	if err != nil {
		t.Fatal(err)
	}
	db.Apply("A", 1, Put("k", "v"))
	db.Close()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	goodLen := st.Size()

	// Simulate power loss mid-write: half of a frame appended, not synced.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	torn := encodeFrame("A", 2, []Op{Put("torn", "torn")})
	if _, err := f.Write(torn[:len(torn)/2]); err != nil {
		t.Fatal(err)
	}
	f.Close()

	db2, err := Open(path, 128)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	if _, ok := db2.Get("torn"); ok {
		t.Fatal("torn frame effect must not survive recovery")
	}
	// The torn message was never committed: reprocessing it must be new.
	if d, _ := db2.Apply("A", 2, Put("k2", "v2")); d != New {
		t.Fatalf("reprocess torn msg = %v, want new", d)
	}
	if d, _ := db2.Apply("A", 1); d != Duplicate {
		t.Fatalf("committed msg = %v, want duplicate", d)
	}
	st, err = os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() <= goodLen {
		t.Fatalf("wal did not grow after new apply: %d <= %d", st.Size(), goodLen)
	}
}

func TestCorruptCRCRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wal")
	db, err := Open(path, 128)
	if err != nil {
		t.Fatal(err)
	}
	db.Apply("A", 1, Put("k", "v"))
	db.Close()

	// Append a full-length frame with a bad CRC (torn write that happened
	// to complete the byte count).
	f, _ := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	frame := encodeFrame("A", 2, []Op{Put("bad", "bad")})
	frame[len(frame)-1] ^= 0xff
	f.Write(frame)
	f.Close()

	db2, err := Open(path, 128)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	if _, ok := db2.Get("bad"); ok {
		t.Fatal("corrupt frame effect must not survive recovery")
	}
	if d, _ := db2.Apply("A", 2, Put("k2", "v2")); d != New {
		t.Fatalf("reprocess corrupt msg = %v, want new", d)
	}
}

func TestStickyErrorAfterWriteFailure(t *testing.T) {
	ff := &faultFile{failAt: 1} // crash on the Sync of the first apply
	db, err := OpenWithFile(ff, 128)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Apply("A", 1, Put("k", "v")); err == nil {
		t.Fatal("want error from crashed sync")
	}
	if _, err := db.Apply("A", 2); err == nil {
		t.Fatal("want sticky error after write failure")
	}
	db.Close()

	// Reopen from the durable snapshot: the crashed batch is gone entirely.
	db2, err := OpenWithFile(ff.snapshot(), 128)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	if d, _ := db2.Apply("A", 1, Put("k", "v")); d != New {
		t.Fatalf("uncommitted msg after reopen = %v, want new", d)
	}
}
