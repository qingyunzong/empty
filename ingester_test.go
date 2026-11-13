package dataeng

import (
	"errors"
	"testing"

	"example.org/dataeng13/q0417/appendlog"
)

func rec(epoch, seq int, digest string) Record {
	return Record{Epoch: epoch, Seq: seq, Digest: digest}
}

func newTestIngester(t *testing.T) (*Ingester, *appendlog.MemLog) {
	t.Helper()
	log := appendlog.NewMemLog()
	ing, err := NewIngester(log)
	if err != nil {
		t.Fatalf("NewIngester: %v", err)
	}
	return ing, log
}

func TestHappyPathFirstEpochStartsAtZero(t *testing.T) {
	ing, log := newTestIngester(t)

	appended, err := ing.Submit([]Record{
		rec(1, 0, "a0"),
		rec(1, 1, "a1"),
		rec(1, 2, "a2"),
	})
	if err != nil || appended != 3 {
		t.Fatalf("Submit = (%d, %v), want (3, nil)", appended, err)
	}
	if seq, ok := ing.MaxSeq(1); !ok || seq != 2 {
		t.Fatalf("MaxSeq(1) = (%d, %v), want (2, true)", seq, ok)
	}
	if frames, _ := log.Read(); len(frames) != 3 {
		t.Fatalf("log has %d frames, want 3", len(frames))
	}
}

func TestMixedEpochRejectsWholeBatchWithoutSeal(t *testing.T) {
	ing, log := newTestIngester(t)

	_, err := ing.Submit([]Record{rec(1, 0, "a"), rec(2, 0, "b")})
	if !errors.Is(err, ErrMixedEpoch) {
		t.Fatalf("err = %v, want ErrMixedEpoch", err)
	}
	if frames, _ := log.Read(); len(frames) != 0 {
		t.Fatalf("log has %d frames, want 0", len(frames))
	}
	if ing.IsSealed(1) || ing.IsSealed(2) {
		t.Fatal("mixed-epoch batch must not seal any epoch")
	}
}

func TestNewEpochRejectsNonZeroStart(t *testing.T) {
	ing, _ := newTestIngester(t)

	_, err := ing.Submit([]Record{rec(1, 1, "a1")})
	if !errors.Is(err, ErrOutOfOrder) {
		t.Fatalf("err = %v, want ErrOutOfOrder", err)
	}
	if _, ok := ing.MaxSeq(1); ok {
		t.Fatal("failed batch must leave no records")
	}
}

func TestGapRejectsBatchAndKeepsState(t *testing.T) {
	ing, _ := newTestIngester(t)

	if _, err := ing.Submit([]Record{rec(1, 0, "a0")}); err != nil {
		t.Fatal(err)
	}
	_, err := ing.Submit([]Record{rec(1, 2, "a2")})
	if !errors.Is(err, ErrOutOfOrder) {
		t.Fatalf("err = %v, want ErrOutOfOrder", err)
	}
	if ing.IsSealed(1) {
		t.Fatal("gap must not seal the epoch")
	}
	if _, ok := ing.StoredDigest(1, 2); ok {
		t.Fatal("gap record must not be stored")
	}

	// The correct next sequence still works.
	if _, err := ing.Submit([]Record{rec(1, 1, "a1")}); err != nil {
		t.Fatalf("retry with seq 1: %v", err)
	}
}

func TestInBatchGapRejectsEntireBatchAtomically(t *testing.T) {
	ing, log := newTestIngester(t)

	_, err := ing.Submit([]Record{rec(1, 0, "a0"), rec(1, 2, "a2")})
	if !errors.Is(err, ErrOutOfOrder) {
		t.Fatalf("err = %v, want ErrOutOfOrder", err)
	}
	if frames, _ := log.Read(); len(frames) != 0 {
		t.Fatalf("log has %d frames, want 0 (all-or-nothing)", len(frames))
	}
}

func TestDuplicateDigestIsIdempotent(t *testing.T) {
	ing, log := newTestIngester(t)

	if _, err := ing.Submit([]Record{rec(1, 0, "a0"), rec(1, 1, "a1")}); err != nil {
		t.Fatal(err)
	}
	appended, err := ing.Submit([]Record{rec(1, 1, "a1")})
	if err != nil || appended != 0 {
		t.Fatalf("duplicate Submit = (%d, %v), want (0, nil)", appended, err)
	}
	if frames, _ := log.Read(); len(frames) != 2 {
		t.Fatalf("log has %d frames, want 2 (no duplicate append)", len(frames))
	}
}

func TestConflictingDigestSealsEpochAndKeepsRecords(t *testing.T) {
	ing, log := newTestIngester(t)

	if _, err := ing.Submit([]Record{rec(1, 0, "a0"), rec(1, 1, "a1")}); err != nil {
		t.Fatal(err)
	}
	_, err := ing.Submit([]Record{rec(1, 1, "different")})
	if !errors.Is(err, ErrDigestConflict) {
		t.Fatalf("err = %v, want ErrDigestConflict", err)
	}
	if !ing.IsSealed(1) {
		t.Fatal("epoch 1 must be sealed")
	}
	if digest, ok := ing.StoredDigest(1, 1); !ok || digest != "a1" {
		t.Fatalf("stored digest = (%q, %v), want a1 kept", digest, ok)
	}
	frames, _ := log.Read()
	if len(frames) != 3 {
		t.Fatalf("log has %d frames, want 2 records + 1 seal", len(frames))
	}

	// Every later submission to the sealed epoch fails.
	if _, err := ing.Submit([]Record{rec(1, 2, "a2")}); !errors.Is(err, ErrSealedEpoch) {
		t.Fatalf("post-seal err = %v, want ErrSealedEpoch", err)
	}
	if _, err := ing.Submit([]Record{rec(1, 0, "a0")}); !errors.Is(err, ErrSealedEpoch) {
		t.Fatalf("duplicate after seal err = %v, want ErrSealedEpoch", err)
	}
}

func TestNewGreatestEpochSealsSmallerEpochs(t *testing.T) {
	ing, _ := newTestIngester(t)

	if _, err := ing.Submit([]Record{rec(1, 0, "a0")}); err != nil {
		t.Fatal(err)
	}
	if _, err := ing.Submit([]Record{rec(2, 0, "b0"), rec(2, 1, "b1")}); err != nil {
		t.Fatalf("new epoch batch: %v", err)
	}
	if !ing.IsSealed(1) {
		t.Fatal("smaller epoch 1 must be sealed")
	}
	if ing.GreatestEpoch() != 2 {
		t.Fatalf("GreatestEpoch = %d, want 2", ing.GreatestEpoch())
	}

	if _, err := ing.Submit([]Record{rec(1, 1, "a1")}); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("stale epoch err = %v, want ErrStaleEpoch", err)
	}
}

func TestEmptyBatchAndInvalidRecord(t *testing.T) {
	ing, _ := newTestIngester(t)

	if _, err := ing.Submit(nil); !errors.Is(err, ErrEmptyBatch) {
		t.Fatalf("empty batch err = %v, want ErrEmptyBatch", err)
	}
	if _, err := ing.Submit([]Record{rec(1, 0, "")}); !errors.Is(err, ErrInvalidRecord) {
		t.Fatalf("empty digest err = %v, want ErrInvalidRecord", err)
	}
}

func TestReplayRebuildsState(t *testing.T) {
	log := appendlog.NewMemLog()
	ing, err := NewIngester(log)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ing.Submit([]Record{rec(1, 0, "a0")}); err != nil {
		t.Fatal(err)
	}
	if _, err := ing.Submit([]Record{rec(1, 0, "bad")}); !errors.Is(err, ErrDigestConflict) {
		t.Fatal("expected conflict")
	}
	if _, err := ing.Submit([]Record{rec(5, 0, "e0")}); err != nil {
		t.Fatal(err)
	}

	rebuilt, err := NewIngester(log)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !rebuilt.IsSealed(1) {
		t.Fatal("replay must restore sealed epoch")
	}
	if rebuilt.GreatestEpoch() != 5 {
		t.Fatalf("replayed greatest = %d, want 5", rebuilt.GreatestEpoch())
	}
	if digest, ok := rebuilt.StoredDigest(1, 0); !ok || digest != "a0" {
		t.Fatalf("replayed digest = (%q, %v)", digest, ok)
	}
	if _, err := rebuilt.Submit([]Record{rec(1, 1, "x")}); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("replayed stale epoch not rejected: %v", err)
	}
}

func TestReplayAcrossFileLog(t *testing.T) {
	path := t.TempDir() + "/log.bin"

	fileLog, err := appendlog.NewFileLog(path)
	if err != nil {
		t.Fatal(err)
	}
	ing, err := NewIngester(fileLog)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ing.Submit([]Record{rec(7, 0, "x"), rec(7, 1, "y")}); err != nil {
		t.Fatal(err)
	}
	if err := fileLog.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := appendlog.NewFileLog(path)
	if err != nil {
		t.Fatal(err)
	}
	rebuilt, err := NewIngester(reopened)
	if err != nil {
		t.Fatal(err)
	}
	if seq, ok := rebuilt.MaxSeq(7); !ok || seq != 1 {
		t.Fatalf("MaxSeq after reopen = (%d, %v), want (1, true)", seq, ok)
	}
	if appended, err := rebuilt.Submit([]Record{rec(7, 2, "z")}); err != nil || appended != 1 {
		t.Fatalf("append after reopen = (%d, %v)", appended, err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestFileLogRecoversPartialTrailingWrite(t *testing.T) {
	path := t.TempDir() + "/log.bin"

	fileLog, err := appendlog.NewFileLog(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := fileLog.Append([]appendlog.Entry{
		{Data: []byte("one")},
		{Data: []byte("two")},
	}); err != nil {
		t.Fatal(err)
	}
	if err := fileLog.Close(); err != nil {
		t.Fatal(err)
	}

	// Simulate a torn batch: append an incomplete frame directly.
	if err := appendFile(path, []byte("99:partial")); err != nil {
		t.Fatal(err)
	}

	recovered, err := appendlog.NewFileLog(path)
	if err != nil {
		t.Fatal(err)
	}
	frames, err := recovered.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 2 || string(frames[0]) != "one" || string(frames[1]) != "two" {
		t.Fatalf("recovered frames = %v, want [one two]", frames)
	}
	if err := recovered.Append([]appendlog.Entry{{Data: []byte("three")}}); err != nil {
		t.Fatal(err)
	}
	frames, _ = recovered.Read()
	if len(frames) != 3 {
		t.Fatalf("frames after recovery append = %d, want 3", len(frames))
	}
	if err := recovered.Close(); err != nil {
		t.Fatal(err)
	}
}
