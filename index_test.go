package auditlog

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRebuildDetectsConflictingDuplicateSeq(t *testing.T) {
	path, _ := buildLog(t,
		EncodeFrame(1, []byte("alpha")),
		EncodeFrame(2, []byte("beta")),
		EncodeFrame(1, []byte("alpha-CONFLICT")),
	)
	_, err := Rebuild(path)
	var dup *DuplicateSeqError
	if !errors.As(err, &dup) {
		t.Fatalf("Rebuild err=%v, want DuplicateSeqError", err)
	}
	if dup.Seq != 1 {
		t.Fatalf("dup.Seq=%d, want 1", dup.Seq)
	}
	// The log itself must be untouched by a failed rebuild.
	entries, truncated, verr := Verify(path)
	if verr != nil || truncated || len(entries) != 3 {
		t.Fatalf("log changed by rebuild: entries=%d truncated=%v err=%v", len(entries), truncated, verr)
	}
}

func TestRebuildToleratesIdenticalDuplicateSeq(t *testing.T) {
	path, _ := buildLog(t,
		EncodeFrame(1, []byte("same")),
		EncodeFrame(2, []byte("other")),
		EncodeFrame(1, []byte("same")),
	)
	idx, err := Rebuild(path)
	if err != nil {
		t.Fatalf("Rebuild: %v", err)
	}
	if len(idx.Offsets) != 2 {
		t.Fatalf("got %d index entries, want 2", len(idx.Offsets))
	}
	if idx.Offsets[1] != 0 {
		t.Fatalf("seq 1 offset=%d, want first occurrence at 0", idx.Offsets[1])
	}
}

// The index may lag the log; Rebuild must catch up from the log alone.
func TestIndexLagAndRebuild(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit.log")
	idxPath := IndexPath(logPath)

	if _, err := Append(logPath, 10, []byte("ten")); err != nil {
		t.Fatal(err)
	}
	// Simulate a lagging index: it knows nothing yet.
	idx, err := LoadIndex(idxPath)
	if err != nil || len(idx.Offsets) != 0 {
		t.Fatalf("lagging index = %+v, %v", idx, err)
	}

	off2, err := Append(logPath, 11, []byte("eleven"))
	if err != nil {
		t.Fatal(err)
	}
	// Best-effort update for the second frame only.
	if err := idx.Update(Entry{Seq: 11, Offset: off2}); err != nil {
		t.Fatal(err)
	}
	if err := idx.Save(idxPath); err != nil {
		t.Fatal(err)
	}

	rebuilt, err := Rebuild(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(rebuilt.Offsets) != 2 || rebuilt.Offsets[10] != 0 || rebuilt.Offsets[11] != off2 {
		t.Fatalf("rebuilt index = %+v", rebuilt.Offsets)
	}
	st, _ := os.Stat(logPath)
	if rebuilt.Covered != st.Size() {
		t.Fatalf("Covered=%d, want log size %d", rebuilt.Covered, st.Size())
	}

	// Round-trip through disk.
	if err := rebuilt.Save(idxPath); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadIndex(idxPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Offsets) != 2 || loaded.Covered != rebuilt.Covered {
		t.Fatalf("loaded index = %+v", loaded)
	}
}

func TestRebuildCorruptLogFails(t *testing.T) {
	path, orig := buildLog(t, EncodeFrame(1, []byte("ok")), EncodeFrame(2, []byte("bad")))
	corrupt := append([]byte(nil), orig...)
	corrupt[len(corrupt)-1] ^= 0xFF // trailing CRC of last frame
	if err := os.WriteFile(path, corrupt, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Rebuild(path); !IsCorrupt(err) {
		t.Fatalf("Rebuild err=%v, want CorruptError", err)
	}
}

func TestIndexUpdateConflict(t *testing.T) {
	idx := &Index{Offsets: map[uint64]int64{5: 100}}
	if err := idx.Update(Entry{Seq: 5, Offset: 100}); err != nil {
		t.Fatalf("same offset must be accepted: %v", err)
	}
	var dup *DuplicateSeqError
	if err := idx.Update(Entry{Seq: 5, Offset: 200}); !errors.As(err, &dup) {
		t.Fatalf("conflicting offset err=%v, want DuplicateSeqError", err)
	}
}
