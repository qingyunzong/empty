package streamdl

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// TestFileStagingInterruptResume exercises the file-backed store across real
// Download calls: an interrupted transfer leaves a durable savepoint, the
// next call resumes with Range/If-Range and the published file matches.
func TestFileStagingInterruptResume(t *testing.T) {
	data := bytes.Repeat([]byte("file-stage-0123"), 16)
	log := &requestLog{}
	cutAt := int64(55)
	server := cutServer(data, etagV1, cutAt, log)
	defer server.Close()

	stageDir := filepath.Join(t.TempDir(), "stage")
	staging := &FileStaging{Dir: stageDir}
	dst := filepath.Join(t.TempDir(), "published.bin")
	dl := &Downloader{
		Request:   requester(server),
		Staging:   staging,
		ChunkSize: 11,
	}

	err := dl.Download(context.Background(), dst, digestOf(data))
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected interruption, got %v", err)
	}

	// A fresh FileStaging instance pointing at the same directory must see the
	// durable savepoint, proving persistence across instances.
	reloaded := &FileStaging{Dir: stageDir}
	staged, exists, err := reloaded.Load(context.Background())
	if err != nil || !exists {
		t.Fatalf("reloaded staging: %+v exists=%v err=%v", staged, exists, err)
	}
	if staged.Length != cutAt || staged.ETag != etagV1 || staged.Total != int64(len(data)) {
		t.Fatalf("unexpected reloaded state: %+v", staged)
	}

	// The on-disk data file must contain at least the persisted prefix.
	info, err := os.Stat(filepath.Join(stageDir, "staging.part"))
	if err != nil || info.Size() < cutAt {
		t.Fatalf("staging data file missing or short: %v size=%d", err, info.Size())
	}

	if err := dl.Download(context.Background(), dst, digestOf(data)); err != nil {
		t.Fatalf("resume download: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("published content mismatch: err=%v", err)
	}
	reqs := log.snapshot()
	if len(reqs) != 2 || reqs[1].rangeHdr != "bytes="+itoa(cutAt)+"-" || reqs[1].ifRangeHdr != etagV1 {
		t.Fatalf("resume headers wrong: %+v", reqs)
	}
	if _, err := os.Stat(filepath.Join(stageDir, "staging.part")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging data must be removed after publish, stat err=%v", err)
	}
}

// TestFileStagingEmptyEntity publishes a zero-length file through the
// file-backed store.
func TestFileStagingEmptyEntity(t *testing.T) {
	log := &requestLog{}
	server := emptyServer(etagV1, log)
	defer server.Close()

	staging := &FileStaging{Dir: filepath.Join(t.TempDir(), "stage")}
	dst := filepath.Join(t.TempDir(), "empty.bin")
	dl := &Downloader{Request: requester(server), Staging: staging}
	var empty [32]byte
	if err := dl.Download(context.Background(), dst, empty); err != nil {
		t.Fatalf("empty download: %v", err)
	}
	info, err := os.Stat(dst)
	if err != nil || info.Size() != 0 {
		t.Fatalf("expected zero-length published file: %v", err)
	}
}

// TestMemStagingCommitAtomicity proves a failed Commit preserves the previous
// savepoint instead of exposing a torn length, and that a later call resumes.
func TestMemStagingCommitAtomicity(t *testing.T) {
	data := []byte("0123456789ABCDEF")
	log := &requestLog{}
	server := staticServer(data, etagV1, log)
	defer server.Close()

	// First establish a durable 8-byte savepoint.
	staging := NewMemStaging()
	txn, err := staging.Begin(context.Background(), 0, etagV1, int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := txn.Write(data[:8]); err != nil {
		t.Fatal(err)
	}
	if _, err := txn.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Now make every further commit fail. A resumed download must surface the
	// durability error and keep the original 8-byte savepoint intact.
	staging.CommitFail = func(int64) error { return errors.New("simulated durability failure") }
	dl := &Downloader{
		Request:   requester(server),
		Staging:   staging,
		ChunkSize: 4,
	}
	err = dl.Download(context.Background(), filepath.Join(t.TempDir(), "x"), digestOf(data))
	if err == nil {
		t.Fatalf("expected durability error")
	}
	staged, exists, err := staging.Load(context.Background())
	if err != nil || !exists {
		t.Fatalf("previous savepoint must survive failed commit: %+v %v %v", staged, exists, err)
	}
	if staged.Length != 8 {
		t.Fatalf("torn length detected: got %d want 8", staged.Length)
	}

	// Clear the fault and confirm a fresh call resumes and publishes correctly.
	staging.CommitFail = nil
	dst := filepath.Join(t.TempDir(), "atomic.bin")
	if err := dl.Download(context.Background(), dst, digestOf(data)); err != nil {
		t.Fatalf("resume after fault cleared: %v", err)
	}
	got, _ := os.ReadFile(dst)
	if !bytes.Equal(got, data) {
		t.Fatalf("content mismatch after recovery")
	}
}
