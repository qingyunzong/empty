package dataeng

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func newCoordinator() (*Coordinator, *MemoryBackend, *MemoryStore) {
	backend := NewMemoryBackend()
	store := NewMemoryStore()
	return NewCoordinator(backend, store), backend, store
}

func mustBegin(t *testing.T, c *Coordinator, key string) *Session {
	t.Helper()
	s, err := c.Begin(context.Background(), key)
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	return s
}

func mustUpload(t *testing.T, c *Coordinator, sessionID string, number int, body string) *Part {
	t.Helper()
	p, err := c.UploadPart(context.Background(), sessionID, number, strings.NewReader(body))
	if err != nil {
		t.Fatalf("UploadPart(%d): %v", number, err)
	}
	return p
}

func TestDuplicatePartSameContentIsIdempotent(t *testing.T) {
	c, _, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")

	p1 := mustUpload(t, c, s.ID, 1, "hello")
	p2, err := c.UploadPart(ctx, s.ID, 1, strings.NewReader("hello"))
	if err != nil {
		t.Fatalf("duplicate upload with same content: %v", err)
	}
	if p1.ETag != p2.ETag || p1.ChecksumSHA256 != p2.ChecksumSHA256 {
		t.Fatalf("duplicate upload returned different part: %+v vs %+v", p1, p2)
	}

	got, _ := c.Get(ctx, s.ID)
	if len(got.Parts) != 1 {
		t.Fatalf("expected 1 recorded part, got %d", len(got.Parts))
	}
}

func TestDuplicatePartDifferentContentConflicts(t *testing.T) {
	c, _, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")

	mustUpload(t, c, s.ID, 1, "hello")
	_, err := c.UploadPart(ctx, s.ID, 1, strings.NewReader("HELLO"))
	if !errors.Is(err, ErrPartConflict) {
		t.Fatalf("expected ErrPartConflict, got %v", err)
	}

	got, _ := c.Get(ctx, s.ID)
	if got.Parts[1].Size != int64(len("hello")) {
		t.Fatalf("original part was overwritten: %+v", got.Parts[1])
	}
}

func TestCompleteBindsGeneration(t *testing.T) {
	c, backend, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")

	mustUpload(t, c, s.ID, 2, "world")
	mustUpload(t, c, s.ID, 1, "hello ")

	res, err := c.Complete(ctx, s.ID)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if res.Generation != 1 {
		t.Fatalf("expected generation 1, got %d", res.Generation)
	}

	info, data, err := backend.GetObject("obj")
	if err != nil {
		t.Fatalf("GetObject: %v", err)
	}
	if string(data) != "hello world" {
		t.Fatalf("object content = %q, want %q", data, "hello world")
	}
	if info.Generation != res.Generation || info.ETag != res.ETag {
		t.Fatalf("result not bound to object generation: %+v vs %+v", res, info)
	}

	got, _ := c.Get(ctx, s.ID)
	if got.State != StateCompleted || got.Result == nil || got.Result.Generation != res.Generation {
		t.Fatalf("session not bound to result: %+v", got)
	}
}

func TestCompleteIsIdempotent(t *testing.T) {
	c, backend, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")
	mustUpload(t, c, s.ID, 1, "data")

	r1, err := c.Complete(ctx, s.ID)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	r2, err := c.Complete(ctx, s.ID)
	if err != nil {
		t.Fatalf("second Complete: %v", err)
	}
	if *r1 != *r2 {
		t.Fatalf("idempotent complete returned different results: %+v vs %+v", r1, r2)
	}
	if backend.Generations("obj") != 1 {
		t.Fatalf("expected exactly 1 generation, got %d", backend.Generations("obj"))
	}
}

func TestCompleteAbortRaceSingleTerminalState(t *testing.T) {
	for i := 0; i < 50; i++ {
		c, backend, _ := newCoordinator()
		ctx := context.Background()
		s := mustBegin(t, c, "obj")
		mustUpload(t, c, s.ID, 1, "payload")

		var wg sync.WaitGroup
		var completeRes *CompleteResult
		var completeErr, abortErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			completeRes, completeErr = c.Complete(ctx, s.ID)
		}()
		go func() {
			defer wg.Done()
			abortErr = c.Abort(ctx, s.ID)
		}()
		wg.Wait()

		got, err := c.Get(ctx, s.ID)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if !got.State.Terminal() {
			t.Fatalf("iteration %d: non-terminal state %s", i, got.State)
		}

		completed := completeErr == nil
		aborted := abortErr == nil
		if completed && aborted {
			t.Fatalf("iteration %d: both complete and abort succeeded", i)
		}
		if !completed && !aborted {
			t.Fatalf("iteration %d: neither operation succeeded (complete: %v, abort: %v)", i, completeErr, abortErr)
		}

		wantGens := 0
		wantState := StateAborted
		if completed {
			wantGens = 1
			wantState = StateCompleted
			if completeRes == nil || got.Result == nil || got.Result.Generation != completeRes.Generation {
				t.Fatalf("iteration %d: completed session not bound to generation", i)
			}
		}
		if got.State != wantState {
			t.Fatalf("iteration %d: state %s, want %s", i, got.State, wantState)
		}
		if g := backend.Generations("obj"); g != wantGens {
			t.Fatalf("iteration %d: %d generations, want %d", i, g, wantGens)
		}
	}
}

func TestAbortThenCompleteFails(t *testing.T) {
	c, _, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")
	mustUpload(t, c, s.ID, 1, "data")

	if err := c.Abort(ctx, s.ID); err != nil {
		t.Fatalf("Abort: %v", err)
	}
	if _, err := c.Complete(ctx, s.ID); !errors.Is(err, ErrSessionTerminal) {
		t.Fatalf("Complete after abort: expected ErrSessionTerminal, got %v", err)
	}
	if _, err := c.UploadPart(ctx, s.ID, 2, strings.NewReader("x")); !errors.Is(err, ErrSessionNotActive) {
		t.Fatalf("UploadPart after abort: expected ErrSessionNotActive, got %v", err)
	}
	// Abort is idempotent.
	if err := c.Abort(ctx, s.ID); err != nil {
		t.Fatalf("second Abort: %v", err)
	}
}

func TestCompleteThenAbortFails(t *testing.T) {
	c, _, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")
	mustUpload(t, c, s.ID, 1, "data")

	if _, err := c.Complete(ctx, s.ID); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if err := c.Abort(ctx, s.ID); !errors.Is(err, ErrSessionTerminal) {
		t.Fatalf("Abort after complete: expected ErrSessionTerminal, got %v", err)
	}
}

// TestResumeDoesNotSpliceOtherUploads creates two concurrent uploads to the
// same key and verifies that recovery and completion only ever use parts
// from the session's own upload ID.
func TestResumeDoesNotSpliceOtherUploads(t *testing.T) {
	c, backend, _ := newCoordinator()
	ctx := context.Background()

	mine := mustBegin(t, c, "obj")
	other := mustBegin(t, c, "obj")
	if mine.UploadID == other.UploadID {
		t.Fatal("sessions share an upload ID")
	}

	mustUpload(t, c, mine.ID, 1, "mine-1 ")
	mustUpload(t, c, mine.ID, 2, "mine-2")
	mustUpload(t, c, other.ID, 1, "other-1 ")
	mustUpload(t, c, other.ID, 2, "other-2")

	resumed, err := c.Resume(ctx, mine.ID)
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if len(resumed.Parts) != 2 {
		t.Fatalf("expected 2 parts after resume, got %d", len(resumed.Parts))
	}

	res, err := c.Complete(ctx, mine.ID)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	_, data, err := backend.GetObject("obj")
	if err != nil {
		t.Fatalf("GetObject: %v", err)
	}
	if string(data) != "mine-1 mine-2" {
		t.Fatalf("object content = %q, parts from another upload were spliced in", data)
	}
	if res.Generation != 1 {
		t.Fatalf("expected generation 1, got %d", res.Generation)
	}

	// The other upload is untouched and can complete independently.
	if _, err := c.Complete(ctx, other.ID); err != nil {
		t.Fatalf("Complete other: %v", err)
	}
	_, data, _ = backend.GetObject("obj")
	if string(data) != "other-1 other-2" {
		t.Fatalf("second generation content = %q", data)
	}
}

func TestResumePrunesPartsMissingRemotely(t *testing.T) {
	c, backend, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")
	mustUpload(t, c, s.ID, 1, "kept")
	mustUpload(t, c, s.ID, 2, "lost")

	// Simulate a remote part expiring before the process restarted.
	backend.mu.Lock()
	delete(backend.uploads[uploadKey("obj", s.UploadID)].parts, 2)
	backend.mu.Unlock()

	resumed, err := c.Resume(ctx, s.ID)
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if len(resumed.Parts) != 1 {
		t.Fatalf("expected missing part to be pruned, parts: %v", resumed.Parts)
	}
	// Part 2 can be re-uploaded after pruning.
	mustUpload(t, c, s.ID, 2, "lost")
	if _, err := c.Complete(ctx, s.ID); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	_, data, _ := backend.GetObject("obj")
	if string(data) != "keptlost" {
		t.Fatalf("object content = %q", data)
	}
}

func TestResumeDetectsOrphanRemotePart(t *testing.T) {
	c, backend, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")
	mustUpload(t, c, s.ID, 1, "recorded")

	// A part lands remotely (same upload ID) without a manifest record,
	// e.g. a store write was lost after the backend call succeeded.
	if _, err := backend.UploadPart(ctx, "obj", s.UploadID, 2, []byte("unrecorded")); err != nil {
		t.Fatalf("UploadPart: %v", err)
	}

	_, err := c.Resume(ctx, s.ID)
	if !errors.Is(err, ErrOrphanPart) {
		t.Fatalf("expected ErrOrphanPart, got %v", err)
	}
}

func TestResumeAbortsWhenRemoteUploadGone(t *testing.T) {
	c, backend, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")
	mustUpload(t, c, s.ID, 1, "data")

	if err := backend.AbortUpload(ctx, "obj", s.UploadID); err != nil {
		t.Fatalf("AbortUpload: %v", err)
	}
	if _, err := c.Resume(ctx, s.ID); !errors.Is(err, ErrUploadNotFound) {
		t.Fatalf("expected ErrUploadNotFound, got %v", err)
	}
	got, _ := c.Get(ctx, s.ID)
	if got.State != StateAborted {
		t.Fatalf("state = %s, want %s", got.State, StateAborted)
	}
}

func TestCompleteFailsWhenRemotePartMissing(t *testing.T) {
	c, backend, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")
	mustUpload(t, c, s.ID, 1, "kept")
	mustUpload(t, c, s.ID, 2, "dropped")

	backend.mu.Lock()
	delete(backend.uploads[uploadKey("obj", s.UploadID)].parts, 2)
	backend.mu.Unlock()

	if _, err := c.Complete(ctx, s.ID); !errors.Is(err, ErrPartConflict) {
		t.Fatalf("expected ErrPartConflict, got %v", err)
	}
	got, _ := c.Get(ctx, s.ID)
	if got.State != StateActive {
		t.Fatalf("state = %s, want %s (retryable)", got.State, StateActive)
	}
}

func TestCompleteEmptyUploadFails(t *testing.T) {
	c, _, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")
	if _, err := c.Complete(ctx, s.ID); !errors.Is(err, ErrNoParts) {
		t.Fatalf("expected ErrNoParts, got %v", err)
	}
}

func TestInvalidPartNumber(t *testing.T) {
	c, _, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")
	for _, n := range []int{0, -1, 10001} {
		if _, err := c.UploadPart(ctx, s.ID, n, strings.NewReader("x")); !errors.Is(err, ErrInvalidPartNumber) {
			t.Fatalf("part number %d: expected ErrInvalidPartNumber, got %v", n, err)
		}
	}
}

func TestConcurrentPartUploads(t *testing.T) {
	c, _, _ := newCoordinator()
	ctx := context.Background()
	s := mustBegin(t, c, "obj")

	var wg sync.WaitGroup
	errs := make([]error, 100)
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			body := fmt.Sprintf("part-%03d", n)
			_, errs[n-1] = c.UploadPart(ctx, s.ID, n, bytes.NewReader([]byte(body)))
		}(i + 1)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("part %d: %v", i+1, err)
		}
	}
	res, err := c.Complete(ctx, s.ID)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if res.Size == 0 {
		t.Fatal("empty completed object")
	}
}
