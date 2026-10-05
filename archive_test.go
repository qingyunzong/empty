package archive

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func openStore(t *testing.T, opts ...Option) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(dir, opts...)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s, dir
}

func blockFiles(t *testing.T, dir string) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, "blocks"))
	if err != nil {
		t.Fatalf("ReadDir blocks: %v", err)
	}
	return entries
}

func TestPutDeduplicatesByBytes(t *testing.T) {
	s, dir := openStore(t)

	h1, err := s.Put([]byte("hello archive"))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	h2, err := s.Put([]byte("hello archive"))
	if err != nil {
		t.Fatalf("Put again: %v", err)
	}
	if h1 != h2 {
		t.Fatalf("same content produced different hashes: %s vs %s", h1, h2)
	}
	if got := blockFiles(t, dir); len(got) != 1 {
		t.Fatalf("expected 1 block file after dedup, got %d", len(got))
	}
}

func TestDigestCollisionsConfirmedByBytes(t *testing.T) {
	// Force every block into the same short-digest bucket.
	collide := func([]byte) uint64 { return 42 }
	s, dir := openStore(t, WithDigestFunc(collide))

	payloads := [][]byte{[]byte("alpha"), []byte("beta"), []byte("gamma")}
	hashes := make([]string, len(payloads))
	for i, p := range payloads {
		h, err := s.Put(p)
		if err != nil {
			t.Fatalf("Put %q: %v", p, err)
		}
		hashes[i] = h
	}
	// Colliding digests must not merge distinct contents.
	seen := map[string]bool{}
	for _, h := range hashes {
		if seen[h] {
			t.Fatalf("collision caused false dedup of distinct contents")
		}
		seen[h] = true
	}
	// Re-putting "beta" must still dedup correctly via byte confirmation.
	again, err := s.Put([]byte("beta"))
	if err != nil {
		t.Fatalf("re-Put: %v", err)
	}
	if again != hashes[1] {
		t.Fatalf("re-Put returned %s, want %s", again, hashes[1])
	}
	if got := blockFiles(t, dir); len(got) != 3 {
		t.Fatalf("expected 3 distinct block files, got %d", len(got))
	}

	if _, err := s.Publish("all", hashes); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	out, err := s.Extract("all")
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}
	if string(out) != "alphabetagamma" {
		t.Fatalf("Extract = %q, want %q", out, "alphabetagamma")
	}
}

func TestPublishRetryDoesNotDoubleCount(t *testing.T) {
	s, dir := openStore(t)

	h, err := s.Put([]byte("block-1"))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	m1, err := s.Publish("m1", []string{h})
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if got := s.RefCount(h); got != 1 {
		t.Fatalf("RefCount after publish = %d, want 1", got)
	}

	// In-process retry.
	m2, err := s.Publish("m1", []string{h})
	if err != nil {
		t.Fatalf("Publish retry: %v", err)
	}
	if !reflect.DeepEqual(m1, m2) {
		t.Fatalf("retry returned different manifest: %+v vs %+v", m1, m2)
	}
	if got := s.RefCount(h); got != 1 {
		t.Fatalf("RefCount after in-process retry = %d, want 1", got)
	}

	// Retry after a restart (manifest already on disk).
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if _, err := s2.Publish("m1", []string{h}); err != nil {
		t.Fatalf("Publish after reopen: %v", err)
	}
	if got := s2.RefCount(h); got != 1 {
		t.Fatalf("RefCount after restart retry = %d, want 1", got)
	}
}

func TestRecoveryRepairsCountsAndKeepsStagedBlocks(t *testing.T) {
	s, dir := openStore(t)

	used, err := s.Put([]byte("used"))
	if err != nil {
		t.Fatalf("Put used: %v", err)
	}
	staged, err := s.Put([]byte("staged, never published"))
	if err != nil {
		t.Fatalf("Put staged: %v", err)
	}
	if _, err := s.Publish("committed", []string{used}); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// Simulate a crash after a second manifest file was written but before
	// counts.json was updated: hand-write the manifest and corrupt counts.
	sum := sha256.Sum256([]byte("used"))
	crashed := Manifest{
		ID:     "crashed",
		Blocks: []string{used},
		Size:   int64(len("used")),
		SHA256: hex.EncodeToString(sum[:]),
	}
	data, err := json.Marshal(crashed)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifests", "crashed.json"), data, 0o644); err != nil {
		t.Fatalf("write crashed manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "counts.json"), []byte(`{"stale": 7}`), 0o644); err != nil {
		t.Fatalf("corrupt counts: %v", err)
	}

	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("Open after crash: %v", err)
	}
	if got := s2.RefCount(used); got != 2 {
		t.Fatalf("RefCount(used) after recovery = %d, want 2 (committed + crashed)", got)
	}
	if got := s2.RefCount(staged); got != 0 {
		t.Fatalf("RefCount(staged) = %d, want 0", got)
	}
	if !s2.BlockExists(staged) {
		t.Fatalf("staged block was lost during recovery")
	}
	out, err := s2.Extract("crashed")
	if err != nil {
		t.Fatalf("Extract crashed manifest: %v", err)
	}
	if string(out) != "used" {
		t.Fatalf("Extract = %q, want %q", out, "used")
	}
}

func TestExtractVerifiesFullBytes(t *testing.T) {
	s, dir := openStore(t)

	h1, err := s.Put([]byte("part1-"))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	h2, err := s.Put([]byte("part2"))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	m, err := s.Publish("doc", []string{h1, h2})
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}

	out, err := s.Extract("doc")
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}
	if !bytes.Equal(out, []byte("part1-part2")) {
		t.Fatalf("Extract = %q, want %q", out, "part1-part2")
	}
	sum := sha256.Sum256([]byte("part1-part2"))
	if m.Size != int64(len("part1-part2")) || m.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("manifest checksum fields wrong: %+v", m)
	}

	// Tamper with a block: extraction must fail the full-byte check.
	if err := os.WriteFile(filepath.Join(dir, "blocks", h2), []byte("XXXXX"), 0o644); err != nil {
		t.Fatalf("tamper: %v", err)
	}
	if _, err := s.Extract("doc"); err == nil {
		t.Fatalf("Extract succeeded on tampered block, want checksum error")
	}
}

func TestReleaseCollectsUnreferencedBlocks(t *testing.T) {
	s, _ := openStore(t)

	a, err := s.Put([]byte("a"))
	if err != nil {
		t.Fatalf("Put a: %v", err)
	}
	b, err := s.Put([]byte("b"))
	if err != nil {
		t.Fatalf("Put b: %v", err)
	}
	if _, err := s.Publish("m1", []string{a, b}); err != nil {
		t.Fatalf("Publish m1: %v", err)
	}
	if _, err := s.Publish("m2", []string{b}); err != nil {
		t.Fatalf("Publish m2: %v", err)
	}

	if err := s.Release("m1"); err != nil {
		t.Fatalf("Release m1: %v", err)
	}
	if s.BlockExists(a) {
		t.Fatalf("block a should be collected after count reached 0")
	}
	if !s.BlockExists(b) || s.RefCount(b) != 1 {
		t.Fatalf("block b should survive with count 1, exists=%v count=%d", s.BlockExists(b), s.RefCount(b))
	}

	// Releasing again is a no-op.
	if err := s.Release("m1"); err != nil {
		t.Fatalf("Release m1 again: %v", err)
	}
	if err := s.Release("m2"); err != nil {
		t.Fatalf("Release m2: %v", err)
	}
	if s.BlockExists(b) {
		t.Fatalf("block b should be collected after both manifests released")
	}
}
