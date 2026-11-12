package dataeng

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"testing"
)

var errInjectedWrite = errors.New("injected write interruption")
var errInjectedRead = errors.New("injected read failure")

func digestOf(data []byte) []byte {
	sum := sha256.Sum256(data)
	return sum[:]
}

// buildManifest builds a manifest and the expected chunk bytes. Passing a
// non-nil badFileDigest overrides the whole-file digest for mismatch tests.
func buildManifest(badFileDigest []byte, chunkTexts ...string) (*Manifest, [][]byte) {
	chunks := make([][]byte, len(chunkTexts))
	specs := make([]ChunkSpec, len(chunkTexts))
	fileHasher := sha256.New()
	for i, text := range chunkTexts {
		chunks[i] = []byte(text)
		specs[i] = ChunkSpec{Length: len(text), SHA256: digestOf(chunks[i])}
		fileHasher.Write(chunks[i])
	}
	fileDigest := fileHasher.Sum(nil)
	if badFileDigest != nil {
		fileDigest = badFileDigest
	}
	return &Manifest{
		TotalChunks: len(chunkTexts),
		FileSHA256:  append([]byte(nil), fileDigest...),
		Chunks:      specs,
	}, chunks
}

func TestOutOfOrderAssemblyAndDuplicate(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "alpha-", "beta-", "gamma", "")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}

	order := []int{2, 0, 3, 1}
	for _, idx := range order {
		if err := c.AddChunk(ctx, idx, chunks[idx]); err != nil {
			t.Fatalf("AddChunk(%d): %v", idx, err)
		}
	}

	// Re-delivered identical chunks are accepted without writes or conflicts.
	for _, idx := range order {
		if err := c.AddChunk(ctx, idx, chunks[idx]); err != nil {
			t.Fatalf("re-delivery of chunk %d: %v", idx, err)
		}
	}

	// Conflicting re-delivery must be reported, and the original bytes survive.
	// A second collector with a replacement manifest still sees the original
	// marker in the shared sink, so a valid same-length replacement reaches the
	// byte-level duplicate check and conflicts.
	specs := make([]ChunkSpec, len(chunks))
	copy(specs, manifest.Chunks)
	replacement := []byte("aaaaa")
	if len(replacement) != specs[1].Length {
		t.Fatalf("test setup: replacement length %d != chunk length %d",
			len(replacement), specs[1].Length)
	}
	specs[1].SHA256 = digestOf(replacement)
	replacementManifest := &Manifest{
		TotalChunks: manifest.TotalChunks,
		FileSHA256:  manifest.FileSHA256,
		Chunks:      specs,
	}
	sink.Retain()
	conflictCollector, err := NewCollector(replacementManifest, sink)
	if err != nil {
		t.Fatalf("NewCollector with replacement manifest: %v", err)
	}
	if err := conflictCollector.AddChunk(ctx, 1, replacement); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
	stored, ok := sink.StoredChunk(1)
	if !ok || !bytes.Equal(stored, chunks[1]) {
		t.Fatalf("original chunk 1 mutated after conflict: %q", stored)
	}

	if err := c.Complete(ctx); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	published, ok := sink.PublishedFile()
	if !ok || string(published) != "alpha-beta-gamma" {
		t.Fatalf("unexpected published content: %q (ok=%v)", published, ok)
	}
	if sink.PublishAttempts() != 1 {
		t.Fatalf("expected exactly one publish attempt, got %d", sink.PublishAttempts())
	}
}

func TestInvalidChunkRejectedBeforeWrite(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "abc", "def")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}

	if err := c.AddChunk(ctx, -1, chunks[0]); !errors.Is(err, ErrChunkIndexOutOfRange) {
		t.Fatalf("expected index error, got %v", err)
	}
	if err := c.AddChunk(ctx, 2, chunks[0]); !errors.Is(err, ErrChunkIndexOutOfRange) {
		t.Fatalf("expected index error, got %v", err)
	}
	short := chunks[0][:2]
	if err := c.AddChunk(ctx, 0, short); !errors.Is(err, ErrLengthMismatch) {
		t.Fatalf("expected length error, got %v", err)
	}
	badDigest := append([]byte(nil), chunks[0]...)
	badDigest[0] = badDigest[0] + 1
	if err := c.AddChunk(ctx, 0, badDigest); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("expected digest error, got %v", err)
	}

	if sink.IsMarked(0) || sink.HasChunk(0) {
		t.Fatal("invalid chunk must not reach staging")
	}
	if err := c.Complete(ctx); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("expected ErrIncomplete, got %v", err)
	}
	if sink.IsPublished() {
		t.Fatal("must not publish an incomplete file")
	}
}

func TestWriteInterruptionLeavesNoMarker(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "one", "two")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}

	// A hard staging failure must roll back cleanly.
	sink.FailStageCommit(errInjectedWrite)
	if err := c.AddChunk(ctx, 0, chunks[0]); !errors.Is(err, errInjectedWrite) {
		t.Fatalf("expected injected error, got %v", err)
	}
	if sink.IsMarked(0) || sink.HasChunk(0) {
		t.Fatal("failed staging transaction left marker or bytes")
	}

	// Retrying the same chunk succeeds and still results in one publish.
	if err := c.AddChunk(ctx, 0, chunks[0]); err != nil {
		t.Fatalf("retry chunk 0: %v", err)
	}
	sink.FailPutChunk(errInjectedWrite)
	if err := c.AddChunk(ctx, 1, chunks[1]); !errors.Is(err, errInjectedWrite) {
		t.Fatalf("expected injected put error, got %v", err)
	}
	if sink.IsMarked(1) || sink.HasChunk(1) {
		t.Fatal("failed PutChunk left marker or bytes")
	}
	if err := c.AddChunk(ctx, 1, chunks[1]); err != nil {
		t.Fatalf("retry chunk 1: %v", err)
	}
	if err := c.Complete(ctx); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !sink.IsPublished() || sink.PublishAttempts() != 1 {
		t.Fatal("file should publish exactly once after retries")
	}
}

func TestAmbiguousStagingCommitConfirmedAndRejected(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "amb")

	// Case 1: commit actually landed; confirmation reads marker and bytes.
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	sink.AmbiguousStageCommit(true)
	if err := c.AddChunk(ctx, 0, chunks[0]); err != nil {
		t.Fatalf("ambiguous-but-committed chunk: %v", err)
	}
	if !sink.IsMarked(0) {
		t.Fatal("confirmed marker missing after ambiguous commit")
	}
	if err := c.Complete(ctx); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	// Case 2: commit did not land; ambiguity surfaces without a false marker.
	sink2 := NewMemSink()
	c2, err := NewCollector(manifest, sink2)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	sink2.AmbiguousStageCommit(false)
	if err := c2.AddChunk(ctx, 0, chunks[0]); !errors.Is(err, ErrCommitAmbiguous) {
		t.Fatalf("expected ErrCommitAmbiguous, got %v", err)
	}
	if sink2.IsMarked(0) || sink2.HasChunk(0) {
		t.Fatal("uncommitted ambiguous txn must not leave state")
	}

	// Case 3: confirmation read fails; the collector stops and stays stopped.
	sink3 := NewMemSink()
	c3, err := NewCollector(manifest, sink3)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	sink3.AmbiguousStageCommit(true)
	sink3.FailMarkerRead(errInjectedRead)
	if err := c3.AddChunk(ctx, 0, chunks[0]); !errors.Is(err, ErrStopped) {
		t.Fatalf("expected ErrStopped, got %v", err)
	}
	if err := c3.AddChunk(ctx, 0, chunks[0]); !errors.Is(err, ErrStopped) {
		t.Fatalf("stopped collector must stay stopped, got %v", err)
	}
}

func TestDuplicateConflict(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "same-length")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	if err := c.AddChunk(ctx, 0, chunks[0]); err != nil {
		t.Fatalf("AddChunk: %v", err)
	}

	// Same-length replacement still passes length validation. Use a manifest
	// whose digest matches the replacement; the byte-level comparison against
	// the stored chunk must still report the conflict.
	replacement := bytes.Repeat([]byte("x"), len(chunks[0]))
	replacementManifest, replacementChunks := buildManifest(nil, string(replacement))
	sink.Retain()
	conflictCollector, err := NewCollector(replacementManifest, sink)
	if err != nil {
		t.Fatalf("NewCollector with replacement manifest: %v", err)
	}
	if err := conflictCollector.AddChunk(ctx, 0, replacementChunks[0]); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}

	// A read failure while checking a duplicate stops the collector.
	sink.FailReadChunk(errInjectedRead)
	if err := conflictCollector.AddChunk(ctx, 0, replacementChunks[0]); !errors.Is(err, ErrStopped) {
		t.Fatalf("expected ErrStopped, got %v", err)
	}
}

func TestRecoverClearsCorruptAndMissingChunks(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "aaa", "bbb", "ccc")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	for i, data := range chunks {
		if err := c.AddChunk(ctx, i, data); err != nil {
			t.Fatalf("AddChunk(%d): %v", i, err)
		}
	}

	// Damage one chunk and drop another while keeping their markers.
	sink.CorruptChunk(1, []byte("BXX"))
	sink.DropChunk(2)

	// A new collector over the same sink simulates a process restart.
	sink.Retain()
	recovered, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector after restart: %v", err)
	}
	missing, err := recovered.Recover(ctx)
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	wantMissing := map[int]bool{1: true, 2: true}
	if len(missing) != len(wantMissing) {
		t.Fatalf("expected missing %v, got %v", wantMissing, missing)
	}
	for _, idx := range missing {
		if !wantMissing[idx] {
			t.Fatalf("unexpected missing index %d", idx)
		}
		if sink.IsMarked(idx) || sink.HasChunk(idx) {
			t.Fatalf("corrupt chunk %d marker/bytes not cleared", idx)
		}
	}

	// Re-request and redeliver the cleared chunks, then publish.
	if err := recovered.AddChunk(ctx, 1, chunks[1]); err != nil {
		t.Fatalf("redeliver chunk 1: %v", err)
	}
	if err := recovered.AddChunk(ctx, 2, chunks[2]); err != nil {
		t.Fatalf("redeliver chunk 2: %v", err)
	}
	if err := recovered.Complete(ctx); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if got, ok := sink.PublishedFile(); !ok || string(got) != "aaabbbccc" {
		t.Fatalf("unexpected published file %q", got)
	}
}

func TestRecoverReadFailureStops(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "aaa", "bbb")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	if err := c.AddChunk(ctx, 0, chunks[0]); err != nil {
		t.Fatalf("AddChunk(0): %v", err)
	}
	sink.FailReadChunk(errInjectedRead)
	missing, err := c.Recover(ctx)
	if !errors.Is(err, ErrStopped) {
		t.Fatalf("expected ErrStopped, got %v (missing=%v)", err, missing)
	}
	if err := c.Complete(ctx); !errors.Is(err, ErrStopped) {
		t.Fatalf("Complete after stop: %v", err)
	}
}

func TestFinalDigestMismatchDoesNotPublish(t *testing.T) {
	ctx := context.Background()
	badDigest := bytes.Repeat([]byte{0xAB}, DigestSize)
	manifest, chunks := buildManifest(badDigest, "first", "second")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	for i, data := range chunks {
		if err := c.AddChunk(ctx, i, data); err != nil {
			t.Fatalf("AddChunk(%d): %v", i, err)
		}
	}
	if err := c.Complete(ctx); !errors.Is(err, ErrFileDigestMismatch) {
		t.Fatalf("expected ErrFileDigestMismatch, got %v", err)
	}
	if sink.IsPublished() || sink.PublishAttempts() != 0 {
		t.Fatal("must not open a publish transaction before digest verification")
	}
}

func TestPublishInterruptionRetriable(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "p1", "p2")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	for i, data := range chunks {
		if err := c.AddChunk(ctx, i, data); err != nil {
			t.Fatalf("AddChunk(%d): %v", i, err)
		}
	}

	// Hard publish failure: nothing is visible, retry publishes once.
	sink.FailPublishCommit(errInjectedWrite)
	if err := c.Complete(ctx); !errors.Is(err, errInjectedWrite) {
		t.Fatalf("expected injected publish error, got %v", err)
	}
	if sink.IsPublished() {
		t.Fatal("hard publish failure must not publish")
	}
	if err := c.Complete(ctx); err != nil {
		t.Fatalf("retry Complete: %v", err)
	}
	if !sink.IsPublished() || sink.PublishAttempts() != 2 {
		t.Fatalf("retry should publish once, attempts=%d", sink.PublishAttempts())
	}

	// Ambiguous publish that actually landed is resolved via the published flag.
	sink2 := NewMemSink()
	c2, err := NewCollector(manifest, sink2)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	for i, data := range chunks {
		if err := c2.AddChunk(ctx, i, data); err != nil {
			t.Fatalf("AddChunk(%d): %v", i, err)
		}
	}
	sink2.AmbiguousPublishCommit(true)
	if err := c2.Complete(ctx); err != nil {
		t.Fatalf("ambiguous-but-committed publish: %v", err)
	}

	// Ambiguous publish that did not land surfaces the error without a flag.
	sink3 := NewMemSink()
	c3, err := NewCollector(manifest, sink3)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	for i, data := range chunks {
		if err := c3.AddChunk(ctx, i, data); err != nil {
			t.Fatalf("AddChunk(%d): %v", i, err)
		}
	}
	sink3.AmbiguousPublishCommit(false)
	if err := c3.Complete(ctx); !errors.Is(err, ErrCommitAmbiguous) {
		t.Fatalf("expected ErrCommitAmbiguous, got %v", err)
	}
	if sink3.IsPublished() {
		t.Fatal("uncommitted ambiguous publish must not set the flag")
	}
}

func TestNoPrematurePublishingDuringStaging(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "x", "y", "z")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}

	// Inject faults across staging; at no point may the published flag flip.
	sink.FailStageCommit(errInjectedWrite)
	if err := c.AddChunk(ctx, 0, chunks[0]); err == nil {
		t.Fatal("expected injected staging failure")
	}
	if sink.IsPublished() {
		t.Fatal("publish happened during staging failure")
	}
	if err := c.AddChunk(ctx, 0, chunks[0]); err != nil {
		t.Fatalf("retry chunk 0: %v", err)
	}
	if err := c.AddChunk(ctx, 1, chunks[1]); err != nil {
		t.Fatalf("AddChunk(1): %v", err)
	}
	if err := c.Complete(ctx); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("expected ErrIncomplete, got %v", err)
	}
	if sink.IsPublished() || sink.PublishAttempts() != 0 {
		t.Fatal("incomplete file must never reach the publish transaction")
	}
}

func TestCancelReleasesHandleButKeepsChunks(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "keep", "me")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	if err := c.AddChunk(ctx, 0, chunks[0]); err != nil {
		t.Fatalf("AddChunk(0): %v", err)
	}

	c.Cancel()
	if sink.Handles() != 0 {
		t.Fatalf("expected handle released, got %d", sink.Handles())
	}
	if !sink.IsMarked(0) || !sink.HasChunk(0) {
		t.Fatal("confirmed chunk must survive cancellation")
	}
	if err := c.AddChunk(ctx, 1, chunks[1]); !errors.Is(err, ErrClosed) {
		t.Fatalf("expected ErrClosed, got %v", err)
	}
	if err := c.Complete(ctx); !errors.Is(err, ErrClosed) {
		t.Fatalf("expected ErrClosed, got %v", err)
	}

	// A replacement collector over the retained sink can resume from markers.
	sink.Retain()
	resumed, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("resume NewCollector: %v", err)
	}
	missing, err := resumed.Recover(ctx)
	if err != nil {
		t.Fatalf("resume Recover: %v", err)
	}
	if len(missing) != 1 || missing[0] != 1 {
		t.Fatalf("expected only chunk 1 missing, got %v", missing)
	}
	if err := resumed.AddChunk(ctx, 1, chunks[1]); err != nil {
		t.Fatalf("resume AddChunk(1): %v", err)
	}
	if err := resumed.Complete(ctx); err != nil {
		t.Fatalf("resume Complete: %v", err)
	}
}

func TestZeroLengthChunksSupported(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "", "middle", "")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	order := []int{2, 1, 0}
	for _, idx := range order {
		if err := c.AddChunk(ctx, idx, chunks[idx]); err != nil {
			t.Fatalf("AddChunk(%d): %v", idx, err)
		}
	}
	if err := c.Complete(ctx); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if got, ok := sink.PublishedFile(); !ok || string(got) != "middle" {
		t.Fatalf("unexpected published file %q", got)
	}
}

func TestRecoverAmbiguousCleanup(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "aaa", "bbb")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}
	if err := c.AddChunk(ctx, 0, chunks[0]); err != nil {
		t.Fatalf("AddChunk(0): %v", err)
	}
	if err := c.AddChunk(ctx, 1, chunks[1]); err != nil {
		t.Fatalf("AddChunk(1): %v", err)
	}
	sink.CorruptChunk(0, []byte("XXX"))

	// Cleanup commit applied but the result is reported as ambiguous.
	// Confirmation must observe the cleared marker and accept the outcome.
	sink.AmbiguousStageCommit(true)
	missing, err := c.Recover(ctx)
	if err != nil {
		t.Fatalf("Recover with applied ambiguous cleanup: %v", err)
	}
	if len(missing) != 1 || missing[0] != 0 {
		t.Fatalf("expected chunk 0 missing, got %v", missing)
	}
	if sink.IsMarked(0) || sink.HasChunk(0) {
		t.Fatal("ambiguous cleanup that landed must clear marker and bytes")
	}

	// Redeliver and finish the file.
	if err := c.AddChunk(ctx, 0, chunks[0]); err != nil {
		t.Fatalf("redeliver chunk 0: %v", err)
	}
	if err := c.Complete(ctx); err != nil {
		t.Fatalf("Complete: %v", err)
	}
}

func TestInjectedTxnAndBeginFailures(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "aaa", "bbb", "ccc")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}

	// BeginTxn failure is surfaced without touching staging state.
	sink.FailBeginTxn(errInjectedWrite)
	if err := c.AddChunk(ctx, 0, chunks[0]); !errors.Is(err, errInjectedWrite) {
		t.Fatalf("expected begin failure, got %v", err)
	}

	// MarkReceived failure inside the txn must leave no chunk and no marker.
	sink.FailMarkReceived(errInjectedWrite)
	if err := c.AddChunk(ctx, 0, chunks[0]); !errors.Is(err, errInjectedWrite) {
		t.Fatalf("expected mark failure, got %v", err)
	}
	if sink.IsMarked(0) || sink.HasChunk(0) {
		t.Fatal("mark failure must not leave partial staging state")
	}
	if err := c.AddChunk(ctx, 0, chunks[0]); err != nil {
		t.Fatalf("retry chunk 0: %v", err)
	}
	if err := c.AddChunk(ctx, 1, chunks[1]); err != nil {
		t.Fatalf("AddChunk(1): %v", err)
	}
	if err := c.AddChunk(ctx, 2, chunks[2]); err != nil {
		t.Fatalf("AddChunk(2): %v", err)
	}

	// Publish staging failure must never reach a commit.
	attemptsBefore := sink.PublishAttempts()
	sink.FailPublishStage(errInjectedWrite)
	if err := c.Complete(ctx); !errors.Is(err, errInjectedWrite) {
		t.Fatalf("expected publish staging failure, got %v", err)
	}
	if sink.PublishAttempts() != attemptsBefore || sink.IsPublished() {
		t.Fatal("publish staging failure must not commit or publish")
	}

	// RemoveChunk failure during recovery leaves the corrupt chunk untouched.
	sink.CorruptChunk(1, []byte("BXX"))
	sink.FailRemoveChunk(errInjectedWrite)
	missing, err := c.Recover(ctx)
	if !errors.Is(err, errInjectedWrite) {
		t.Fatalf("expected remove failure, got %v (missing=%v)", err, missing)
	}
}

func TestConcurrentAddChunks(t *testing.T) {
	ctx := context.Background()
	manifest, chunks := buildManifest(nil, "c0", "c1", "c2", "c3")
	sink := NewMemSink()
	c, err := NewCollector(manifest, sink)
	if err != nil {
		t.Fatalf("NewCollector: %v", err)
	}

	var wg sync.WaitGroup
	for round := 0; round < 3; round++ {
		for i, data := range chunks {
			wg.Add(1)
			go func(index int, payload []byte) {
				defer wg.Done()
				if err := c.AddChunk(ctx, index, payload); err != nil {
					t.Errorf("AddChunk(%d): %v", index, err)
				}
			}(i, data)
		}
	}
	wg.Wait()

	if err := c.Complete(ctx); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !sink.IsPublished() || sink.PublishAttempts() != 1 {
		t.Fatalf("exactly one publish expected, attempts=%d", sink.PublishAttempts())
	}
}

func TestInvalidManifestRejected(t *testing.T) {
	sink := NewMemSink()
	cases := []struct {
		name     string
		manifest *Manifest
	}{
		{"zero chunks", &Manifest{TotalChunks: 0, FileSHA256: make([]byte, DigestSize)}},
		{"spec count mismatch", &Manifest{
			TotalChunks: 2,
			FileSHA256:  make([]byte, DigestSize),
			Chunks:      []ChunkSpec{{Length: 1, SHA256: make([]byte, DigestSize)}},
		}},
		{"bad file digest length", &Manifest{
			TotalChunks: 1,
			FileSHA256:  make([]byte, DigestSize-1),
			Chunks:      []ChunkSpec{{Length: 0, SHA256: make([]byte, DigestSize)}},
		}},
		{"bad chunk digest length", &Manifest{
			TotalChunks: 1,
			FileSHA256:  make([]byte, DigestSize),
			Chunks:      []ChunkSpec{{Length: 0, SHA256: make([]byte, DigestSize-1)}},
		}},
		{"negative length", &Manifest{
			TotalChunks: 1,
			FileSHA256:  make([]byte, DigestSize),
			Chunks:      []ChunkSpec{{Length: -1, SHA256: make([]byte, DigestSize)}},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewCollector(tc.manifest, sink); !errors.Is(err, ErrInvalidManifest) {
				t.Fatalf("expected ErrInvalidManifest, got %v", err)
			}
		})
	}
}
