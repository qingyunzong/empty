package archive_test

import (
	"bytes"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"

	"archive"
)

func stageAll(t *testing.T, s *archive.Store, chunks ...[]byte) []archive.Digest {
	t.Helper()
	digests := make([]archive.Digest, len(chunks))
	for i, c := range chunks {
		d, err := s.Stage(c)
		if err != nil {
			t.Fatalf("Stage: %v", err)
		}
		digests[i] = d
	}
	return digests
}

func TestPublishAndExtract(t *testing.T) {
	s, err := archive.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	chunks := [][]byte{[]byte("hello "), []byte("archived "), []byte("world")}
	digests := stageAll(t, s, chunks...)

	if err := s.Publish("op-1", "m1", digests); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	for _, d := range digests {
		if got := s.Refcount(d); got != 1 {
			t.Fatalf("refcount = %d, want 1", got)
		}
	}
	want := bytes.Join(chunks, nil)
	if err := s.Verify("m1", want); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

// collidingDigest forces every short digest prefix to collide while
// keeping full digests distinct.
func collidingDigest(b []byte) archive.Digest {
	d := archive.Digest(sha256.Sum256(b))
	d[0], d[1], d[2], d[3] = 0, 0, 0, 0
	return d
}

func TestShortDigestCollision(t *testing.T) {
	s, err := archive.Open(t.TempDir(), archive.WithDigestFunc(collidingDigest))
	if err != nil {
		t.Fatal(err)
	}
	a := []byte("first colliding payload")
	b := []byte("second colliding payload")
	da, err := s.Stage(a)
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.Stage(b)
	if err != nil {
		t.Fatal(err)
	}
	if da == db {
		t.Fatal("test setup: digests should differ only in the short prefix")
	}
	if err := s.Publish("op-1", "m1", []archive.Digest{da, db}); err != nil {
		t.Fatal(err)
	}

	// Located by the same short prefix; bytes must confirm the right block.
	gotA, err := s.Get(da)
	if err != nil || !bytes.Equal(gotA, a) {
		t.Fatalf("Get(a) = %q, %v", gotA, err)
	}
	gotB, err := s.Get(db)
	if err != nil || !bytes.Equal(gotB, b) {
		t.Fatalf("Get(b) = %q, %v", gotB, err)
	}
	if err := s.Verify("m1", append(a, b...)); err != nil {
		t.Fatalf("Verify: %v", err)
	}

	// Collisions must survive a restart too.
	s2, err := archive.Open(s.Dir(), archive.WithDigestFunc(collidingDigest))
	if err != nil {
		t.Fatal(err)
	}
	got, err := s2.Get(db)
	if err != nil || !bytes.Equal(got, b) {
		t.Fatalf("after reopen Get(b) = %q, %v", got, err)
	}
}

func TestPublishRetryDoesNotDoubleCount(t *testing.T) {
	dir := t.TempDir()
	s, err := archive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	digests := stageAll(t, s, []byte("block-1"), []byte("block-2"))

	if err := s.Publish("op-1", "m1", digests); err != nil {
		t.Fatal(err)
	}
	// In-process retry with the same operation ID.
	if err := s.Publish("op-1", "m1", digests); err != nil {
		t.Fatal(err)
	}
	for _, d := range digests {
		if got := s.Refcount(d); got != 1 {
			t.Fatalf("after in-process retry refcount = %d, want 1", got)
		}
	}

	// Retry after a restart: the operation is remembered via the manifest.
	s2, err := archive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s2.Publish("op-1", "m1", digests); err != nil {
		t.Fatal(err)
	}
	for _, d := range digests {
		if got := s2.Refcount(d); got != 1 {
			t.Fatalf("after restart retry refcount = %d, want 1", got)
		}
	}
}

func TestRecoveryRepairsRefcounts(t *testing.T) {
	dir := t.TempDir()
	s, err := archive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	d1 := stageAll(t, s, []byte("shared"))
	d2 := stageAll(t, s, []byte("only-in-m2"))
	if err := s.Publish("op-1", "m1", d1); err != nil {
		t.Fatal(err)
	}
	if err := s.Publish("op-2", "m2", append(d1, d2...)); err != nil {
		t.Fatal(err)
	}

	// Simulate a crash that corrupted the persisted counts.
	if err := os.WriteFile(filepath.Join(dir, "refcounts.json"), []byte(`{"bogus": 99}`), 0o644); err != nil {
		t.Fatal(err)
	}

	s2, err := archive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := s2.Refcount(d1[0]); got != 2 {
		t.Fatalf("shared block refcount = %d, want 2", got)
	}
	if got := s2.Refcount(d2[0]); got != 1 {
		t.Fatalf("m2-only block refcount = %d, want 1", got)
	}
}

func TestRecoveryKeepsStagingBlocks(t *testing.T) {
	dir := t.TempDir()
	s, err := archive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	staged, err := s.Stage([]byte("not yet published"))
	if err != nil {
		t.Fatal(err)
	}
	published := stageAll(t, s, []byte("published"))
	if err := s.Publish("op-1", "m1", published); err != nil {
		t.Fatal(err)
	}

	// "Crash" and recover.
	s2, err := archive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	remaining, err := s2.StagedBlocks()
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 || remaining[0] != staged {
		t.Fatalf("staging blocks after recovery = %v, want [%v]", remaining, staged)
	}
	// The unpublished block must not be reference-counted.
	if got := s2.Refcount(staged); got != 0 {
		t.Fatalf("staging block refcount = %d, want 0", got)
	}
}

func TestExtractDetectsCorruption(t *testing.T) {
	dir := t.TempDir()
	s, err := archive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	digests := stageAll(t, s, []byte("integrity matters"))
	if err := s.Publish("op-1", "m1", digests); err != nil {
		t.Fatal(err)
	}
	// Corrupt the committed block on disk.
	if err := os.WriteFile(filepath.Join(dir, "blocks", digests[0].String()), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Extract("m1"); err == nil {
		t.Fatal("Extract on corrupted block: want error, got nil")
	}
}
