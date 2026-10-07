package fieldsync_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"fieldsync"
	"fieldsync/fakestore"
)

func wantBatch() fieldsync.Batch {
	return fieldsync.Batch{
		Fields: map[string]string{"a": "1", "b": "2"},
		Attachments: []fieldsync.Attachment{
			{ID: "att-1", Data: []byte("payload-one")},
			{ID: "att-2", Data: []byte("payload-two")},
		},
	}
}

func TestSyncWritesAndVerifiesReadBack(t *testing.T) {
	store := fakestore.New()
	s := fieldsync.NewSyncer(store, fieldsync.Config{})

	res, err := s.Sync(context.Background(), "k", wantBatch())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if !res.Wrote {
		t.Fatal("expected a write on first sync")
	}
	if res.Receipt.Version != 1 || res.Receipt.Token != "tok-1" {
		t.Fatalf("unexpected receipt: %+v", res.Receipt)
	}
	if store.Writes() != 1 {
		t.Fatalf("writes = %d, want 1", store.Writes())
	}
}

func TestSyncRetryReadsFirstAndSkipsWrite(t *testing.T) {
	store := fakestore.New()
	s := fieldsync.NewSyncer(store, fieldsync.Config{})
	ctx := context.Background()

	if _, err := s.Sync(ctx, "k", wantBatch()); err != nil {
		t.Fatalf("first Sync: %v", err)
	}
	res, err := s.Sync(ctx, "k", wantBatch())
	if err != nil {
		t.Fatalf("retry Sync: %v", err)
	}
	if res.Wrote {
		t.Fatal("retry must confirm existing state via read, not rewrite")
	}
	if store.Writes() != 1 {
		t.Fatalf("writes = %d, want 1 after retry", store.Writes())
	}
	if res.Receipt.Version != 1 {
		t.Fatalf("retry receipt = %+v, want the original write receipt", res.Receipt)
	}
}

func TestNormalizationAppliesOnlyDeclaredRules(t *testing.T) {
	ctx := context.Background()
	batch := fieldsync.Batch{Fields: map[string]string{"greeting": "hello"}}

	store := fakestore.New()
	if _, err := store.Write(ctx, "k", fieldsync.Batch{
		Fields: map[string]string{"greeting": "  hello  "},
	}); err != nil {
		t.Fatal(err)
	}

	// TrimSpace declared: trailing whitespace is equivalent, no rewrite.
	s := fieldsync.NewSyncer(store, fieldsync.Config{Rules: []fieldsync.EquivalenceRule{fieldsync.TrimSpace()}})
	res, err := s.Sync(ctx, "k", batch)
	if err != nil {
		t.Fatalf("Sync with TrimSpace: %v", err)
	}
	if res.Wrote {
		t.Fatal("declared TrimSpace rule should make values equivalent")
	}

	// Case difference is NOT declared: must be treated as a real difference.
	store2 := fakestore.New()
	if _, err := store2.Write(ctx, "k", fieldsync.Batch{
		Fields: map[string]string{"greeting": "HELLO"},
	}); err != nil {
		t.Fatal(err)
	}
	s2 := fieldsync.NewSyncer(store2, fieldsync.Config{Rules: []fieldsync.EquivalenceRule{fieldsync.TrimSpace()}})
	res, err = s2.Sync(ctx, "k", batch)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if !res.Wrote {
		t.Fatal("undeclared case difference must not be normalized away")
	}
}

func TestAttachmentsOrderInsensitiveButHashMustMatch(t *testing.T) {
	ctx := context.Background()
	want := wantBatch()

	// Same attachments, reversed order: equivalent, no write.
	store := fakestore.New()
	reordered := wantBatch()
	reordered.Attachments[0], reordered.Attachments[1] = reordered.Attachments[1], reordered.Attachments[0]
	if _, err := store.Write(ctx, "k", reordered); err != nil {
		t.Fatal(err)
	}
	s := fieldsync.NewSyncer(store, fieldsync.Config{})
	res, err := s.Sync(ctx, "k", want)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if res.Wrote {
		t.Fatal("attachment order must be irrelevant")
	}

	// Same IDs, different payload: hash mismatch must be detected and reported.
	store2 := fakestore.New()
	store2.TransformWrite = func(_ string, b fieldsync.Batch) fieldsync.Batch {
		b.Attachments[1].Data = []byte("tampered")
		return b
	}
	s2 := fieldsync.NewSyncer(store2, fieldsync.Config{})
	_, err = s2.Sync(ctx, "k", want)
	var verr *fieldsync.VerificationError
	if !errors.As(err, &verr) {
		t.Fatalf("expected VerificationError, got %v", err)
	}
	var missing, unexpected int
	for _, d := range verr.Diffs {
		switch d.Kind {
		case fieldsync.DiffAttachmentMissing:
			missing++
		case fieldsync.DiffAttachmentUnexpected:
			unexpected++
		}
	}
	if missing != 1 || unexpected != 1 {
		t.Fatalf("attachment diffs = %v, want 1 missing + 1 unexpected", verr.Diffs)
	}
}

func TestPartialWritePreservesReceiptAndConcreteDiffs(t *testing.T) {
	store := fakestore.New()
	// Inject a partial write: field "b" and the second attachment never persist.
	store.TransformWrite = func(_ string, b fieldsync.Batch) fieldsync.Batch {
		delete(b.Fields, "b")
		b.Attachments = b.Attachments[:1]
		return b
	}
	s := fieldsync.NewSyncer(store, fieldsync.Config{})

	_, err := s.Sync(context.Background(), "k", wantBatch())
	var verr *fieldsync.VerificationError
	if !errors.As(err, &verr) {
		t.Fatalf("expected VerificationError, got %v", err)
	}

	// Original write receipt is preserved.
	if verr.Receipt.Version != 1 || verr.Receipt.Token != "tok-1" {
		t.Fatalf("receipt = %+v, want version=1 token=tok-1", verr.Receipt)
	}

	// Concrete diffs: field b lost, one attachment hash missing.
	var fieldDiff *fieldsync.Diff
	var missingAtt int
	for i, d := range verr.Diffs {
		switch d.Kind {
		case fieldsync.DiffFieldMismatch:
			fieldDiff = &verr.Diffs[i]
		case fieldsync.DiffAttachmentMissing:
			missingAtt++
		}
	}
	if fieldDiff == nil || fieldDiff.Field != "b" || fieldDiff.Want != "2" || fieldDiff.Got != "" {
		t.Fatalf("field diff = %+v, want field b want=2 got=<empty>", fieldDiff)
	}
	if missingAtt != 1 {
		t.Fatalf("missing attachment diffs = %d, want 1", missingAtt)
	}
}

func TestDelayedReadBackVerifiedWithRetries(t *testing.T) {
	ctx := context.Background()
	cfg := fieldsync.Config{ReadBackAttempts: 4, ReadBackDelay: time.Millisecond}

	// Lag within the retry budget: verification eventually succeeds.
	store := fakestore.New()
	store.ReadLag = 2
	s := fieldsync.NewSyncer(store, cfg)
	res, err := s.Sync(ctx, "k", wantBatch())
	if err != nil {
		t.Fatalf("Sync with lag=2: %v", err)
	}
	if !res.Wrote {
		t.Fatal("expected a write")
	}

	// Lag beyond the retry budget: verification fails with diffs against the
	// stale pre-write snapshot.
	store2 := fakestore.New()
	store2.ReadLag = 10
	s2 := fieldsync.NewSyncer(store2, cfg)
	_, err = s2.Sync(ctx, "k", wantBatch())
	var verr *fieldsync.VerificationError
	if !errors.As(err, &verr) {
		t.Fatalf("expected VerificationError for long lag, got %v", err)
	}
	if verr.Receipt.Version != 1 {
		t.Fatalf("receipt = %+v, want the write receipt", verr.Receipt)
	}
	if len(verr.Diffs) == 0 {
		t.Fatal("expected concrete diffs against the stale snapshot")
	}
}
